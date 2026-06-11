import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import dotenv from 'dotenv'
import axios from 'axios'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ===== CONNECT DATABASE =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log('❌ MongoDB error:', err))

// ===== MODELS =====

const userSchema = new mongoose.Schema({
  piUsername:    { type: String, unique: true, required: true },
  isPremium:     { type: Boolean, default: false },
  premiumExpiry: { type: Date, default: null },
  createdAt:     { type: Date, default: Date.now }
})
const User = mongoose.model('User', userSchema)

const profileSchema = new mongoose.Schema({
  piUsername: { type: String, unique: true, required: true },
  name:       String,
  bio:        String,
  photo:      String,
  updatedAt:  { type: Date, default: Date.now }
})
const Profile = mongoose.model('Profile', profileSchema)

const matchSchema = new mongoose.Schema({
  user1: String,
  user2: String,
  createdAt: { type: Date, default: Date.now }
})
const Match = mongoose.model('Match', matchSchema)

const messageSchema = new mongoose.Schema({
  matchId:   String,
  sender:    String,
  text:      String,
  createdAt: { type: Date, default: Date.now }
})
const Message = mongoose.model('Message', messageSchema)

const paymentSchema = new mongoose.Schema({
  piUsername: String,
  paymentId:  String,
  txid:       String,
  amount:     Number,
  status:     { type: String, default: 'pending' },
  createdAt:  { type: Date, default: Date.now }
})
const Payment = mongoose.model('Payment', paymentSchema)

// ===== MIDDLEWARE =====
const JWT_SECRET = process.env.JWT_SECRET || 'dating-now-secret-2024'

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ===== AUTH =====
app.post('/api/auth/pi-login', async (req, res) => {
  try {
    const { piUsername } = req.body
    if (!piUsername) return res.status(400).json({ error: 'piUsername required' })

    let user = await User.findOne({ piUsername })
    if (!user) {
      user = await User.create({ piUsername })
      await Profile.create({ piUsername, name: piUsername })
    }

    if (user.isPremium && user.premiumExpiry && user.premiumExpiry < new Date()) {
      user.isPremium = false
      user.premiumExpiry = null
      await user.save()
    }

    const token = jwt.sign({ piUsername }, JWT_SECRET, { expiresIn: '30d' })
    const profile = await Profile.findOne({ piUsername })

    res.json({ token, user: { piUsername, isPremium: user.isPremium, premiumExpiry: user.premiumExpiry }, profile })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== PROFILE =====
app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const profile = await Profile.findOne({ piUsername: req.user.piUsername })
    res.json(profile)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/profile/save', authMiddleware, async (req, res) => {
  try {
    const { name, bio, photo } = req.body
    const profile = await Profile.findOneAndUpdate(
      { piUsername: req.user.piUsername },
      { name, bio, photo, updatedAt: new Date() },
      { new: true, upsert: true }
    )
    res.json(profile)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== DISCOVER =====
app.get('/api/discover', authMiddleware, async (req, res) => {
  try {
    const myMatches = await Match.find({
      $or: [{ user1: req.user.piUsername }, { user2: req.user.piUsername }]
    })
    const seen = myMatches.map(m => m.user1 === req.user.piUsername ? m.user2 : m.user1)

    const profiles = await Profile.find({
      piUsername: { $ne: req.user.piUsername, $nin: seen },
      photo: { $exists: true, $ne: null }
    }).limit(20)

    res.json(profiles)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== SWIPE =====
app.post('/api/swipe', authMiddleware, async (req, res) => {
  try {
    const { targetUsername, direction } = req.body
    const me = req.user.piUsername

    const user = await User.findOne({ piUsername: me })
    if (!user.isPremium) {
      const today = new Date(); today.setHours(0,0,0,0)
      const swipesToday = await Match.countDocuments({ user1: me, createdAt: { $gte: today } })
      if (swipesToday >= 50) {
        return res.status(403).json({ error: 'quota_exceeded' })
      }
    }

    if (direction === 'right') {
      await Match.create({ user1: me, user2: targetUsername })
      const theyLikedMe = await Match.findOne({ user1: targetUsername, user2: me })
      if (theyLikedMe) {
        const matchId = [me, targetUsername].sort().join('_')
        return res.json({ matched: true, matchId })
      }
    }

    res.json({ matched: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== MATCHES =====
app.get('/api/matches', authMiddleware, async (req, res) => {
  try {
    const me = req.user.piUsername
    const iliked = await Match.find({ user1: me })
    const theyliked = await Match.find({ user2: me })
    const iLikedSet = new Set(iliked.map(m => m.user2))
    const theyLikedSet = new Set(theyliked.map(m => m.user1))
    const matchedUsernames = [...iLikedSet].filter(u => theyLikedSet.has(u))
    const profiles = await Profile.find({ piUsername: { $in: matchedUsernames } })
    const matches = profiles.map(p => ({
      matchId: [me, p.piUsername].sort().join('_'),
      profile: p,
      matchedAt: new Date()
    }))
    res.json(matches)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== MESSAGES =====
app.get('/api/messages/:matchId', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({ matchId: req.params.matchId }).sort({ createdAt: 1 })
    res.json(messages)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { matchId, text } = req.body
    const me = req.user.piUsername

    const user = await User.findOne({ piUsername: me })
    if (!user.isPremium) {
      const today = new Date(); today.setHours(0,0,0,0)
      const msgsToday = await Message.countDocuments({ sender: me, createdAt: { $gte: today } })
      if (msgsToday >= 10) {
        return res.status(403).json({ error: 'quota_exceeded' })
      }
    }

    const msg = await Message.create({ matchId, sender: me, text })
    res.json(msg)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== PI PAYMENT =====
app.post('/api/payment/approve', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.body
    await Payment.findOneAndUpdate(
      { paymentId },
      { paymentId, piUsername: req.user.piUsername, status: 'pending' },
      { upsert: true, new: true }
    )
    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      { headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` } }
    )
    res.json({ success: true, payment: response.data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/payment/complete', authMiddleware, async (req, res) => {
  try {
    const { paymentId, txid } = req.body
    await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      { txid },
      { headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` } }
    )
    await Payment.findOneAndUpdate({ paymentId }, { txid, status: 'completed' })
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await User.findOneAndUpdate(
      { piUsername: req.user.piUsername },
      { isPremium: true, premiumExpiry: expiry }
    )
    res.json({ success: true, premiumExpiry: expiry })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/user/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ piUsername: req.user.piUsername })
    res.json({ isPremium: user.isPremium, premiumExpiry: user.premiumExpiry })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }))
app.get('/', (req, res) => res.json({ message: '💜 Dating now API is running!' }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`💜 Dating now Backend running on port ${PORT}`))
