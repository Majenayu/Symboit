const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

// Use candidate ID, but logic will handle failures
const GOOGLE_CLIENT_ID = '1026786000139-r37otcf7j25d15eqh08bai1hh8g1fgel.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

app.use(cors());
app.use(express.json());

// Startup Check for Render Env
console.log('--- SYSTEM STARTUP ---');
console.log('GOOGLE_CLIENT_ID:', GOOGLE_CLIENT_ID.substring(0, 20) + '...');
console.log('GOOGLE_CLIENT_SECRET Configured:', !!process.env.GOOGLE_CLIENT_SECRET);
console.log('MONGODB_URI Configured:', !!process.env.MONGODB_URI);
console.log('-----------------------');

// MongoDB Connection
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const userSchema = new mongoose.Schema({
    googleId: String,
    email: { type: String, unique: true },
    name: String,
    role: { type: String, default: 'organizer' }, // organizer, mentor, student
    organizerEmail: String, // The root organizer this user belongs to
    scopes: [String],
    refreshToken: String,
});

const invitationSchema = new mongoose.Schema({
    email: String,
    token: { type: String, unique: true },
    inviterEmail: String,
    organizerEmail: String, // The root organizer for this invitation
    role: String, // mentor, student
    status: { type: String, default: 'pending' }, // pending, accepted
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Invitation = mongoose.model('Invitation', invitationSchema);

// --- Auth Endpoints ---

// Google Auth (Accepts Authorization Code)
app.post('/api/auth/google', async (req, res) => {
    const { code } = req.body;
    try {
        const { tokens } = await client.getToken({
            code,
            redirect_uri: 'postmessage' // Special value for GSI Code Client
        });
        client.setCredentials(tokens);

        const ticket = await client.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        let user = await User.findOne({ email: payload.email });
        if (!user) {
            user = new User({
                googleId: payload.sub,
                email: payload.email,
                name: payload.name,
                role: 'organizer',
                organizerEmail: payload.email,
                refreshToken: tokens.refresh_token,
            });
            await user.save();
        } else {
            // Ensure organizerEmail is set even for existing users
            user.organizerEmail = user.email;
            if (tokens.refresh_token) {
                user.refreshToken = tokens.refresh_token;
            }
            await user.save();
        }
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(401).json({ success: false, error: 'Invalid code' });
    }
});

// Magic/Demo Login (Fix for Auth failure)
app.post('/api/auth/magic', async (req, res) => {
    const { email } = req.body;
    try {
        let user = await User.findOne({ email });
        if (!user) {
            user = new User({ 
                email, 
                name: email.split('@')[0], 
                role: 'organizer',
                organizerEmail: email 
            });
            await user.save();
        } else {
            user.organizerEmail = user.email;
            await user.save();
        }
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Invitation Endpoints ---

// Create Invitation (Organizer -> Mentor or Mentor -> Student)
app.post('/api/invite', async (req, res) => {
    const { email, role, inviterEmail, organizerEmail } = req.body;
    try {
        const token = crypto.randomBytes(20).toString('hex');
        const invitation = new Invitation({
            email,
            token,
            inviterEmail,
            organizerEmail, // Passed from frontend (who is the root)
            role
        });
        await invitation.save();
        
        const inviteLink = `http://localhost:${PORT}?invite=${token}`;
        console.log(`Invite generated for ${email}. Looking for organizer: ${organizerEmail}`);
        const organizer = await User.findOne({ email: organizerEmail });
        
        if (organizer && organizer.refreshToken) {
            console.log(`[AUTH] Refresh Token found for ${organizerEmail}. Secret exists: ${!!process.env.GOOGLE_CLIENT_SECRET}`);
            
            // Manually refresh token to verify it works and get access token
            const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
            oauth2Client.setCredentials({ refresh_token: organizer.refreshToken });

            try {
                const { token: accessToken } = await oauth2Client.getAccessToken();
                console.log(`[AUTH] Access Token generated successfully.`);

                const transporter = nodemailer.createTransport({
                    host: 'smtp.gmail.com',
                    port: 465,
                    secure: true,
                    auth: {
                        type: 'OAuth2',
                        user: organizerEmail,
                        clientId: GOOGLE_CLIENT_ID,
                        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                        refreshToken: organizer.refreshToken,
                        accessToken: accessToken // Pass the fresh token directly
                    }
                });

                const mailOptions = {
                    from: `Symboit System <${organizerEmail}>`,
                    to: email,
                    subject: `Symboit Invitation – join as ${role}`,
                    text: `Hello,\n\nYou have been invited to join Symboit as a ${role}.\n\nAccept invitation here: ${inviteLink}`
                };

                console.log('[AUTH] Sending via manual Access Token...');
                await transporter.sendMail(mailOptions);
                console.log('✅ [AUTH] Success! Email sent.');
                return res.json({ success: true, inviteLink, emailSent: true });
            } catch (authErr) {
                console.error('[AUTH] ❌ Token Refresh/Send Failed:', authErr.message);
                return res.json({ 
                    success: true, 
                    inviteLink, 
                    emailSent: false, 
                    error: 'Gmail auth failed, but invite was created. Please send the link manually.' 
                });
            }
        } else {
            console.warn(`[AUTH] ❌ FAIL: No Refresh Token for ${organizerEmail}.`);
            return res.json({ 
                success: true, 
                inviteLink, 
                emailSent: false, 
                error: 'Gmail auth missing. Use "Sign in with Google (Full Access)" to automate emails.' 
            });
        }
        
        res.json({ success: true, inviteLink });
    } catch (error) {
        console.error('Invite error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify Invitation Token
app.get('/api/invite/:token', async (req, res) => {
    try {
        const invite = await Invitation.findOne({ token: req.params.token, status: 'pending' });
        if (!invite) return res.status(404).json({ success: false, error: 'Invite not found or already used' });
        res.json({ success: true, invite });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Accept Invitation (Registers the user with the correct role)
app.post('/api/invite/accept', async (req, res) => {
    const { token, payload } = req.body;
    try {
        // Find the invitation
        const invitation = await Invitation.findOne({ token, status: 'pending' });
        if (!invitation) return res.status(404).json({ success: false, error: 'Invalid or expired invitation' });

        // Update or create user
        let user = await User.findOne({ email: payload.email });
        if (!user) {
            user = new User({
                googleId: payload.sub,
                email: payload.email,
                name: payload.name,
                role: invitation.role,
                organizerEmail: invitation.organizerEmail // Inherit the tenant!
            });
        } else {
            user.role = invitation.role;
            user.organizerEmail = invitation.organizerEmail;
        }
        await user.save();

        invitation.status = 'accepted';
        await invitation.save();
        
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Data Endpoints ---

// Get Users (Students for Mentor, Mentors for Organizer)
app.get('/api/users', async (req, res) => {
    const { role, organizerEmail } = req.query;
    try {
        const query = { role };
        if (organizerEmail) query.organizerEmail = organizerEmail;
        const users = await User.find(query);
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Invitations (to track pending status)
app.get('/api/invitations', async (req, res) => {
    const { organizerEmail } = req.query;
    try {
        const invites = await Invitation.find({ organizerEmail });
        res.json({ success: true, invites });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete User
app.delete('/api/users/:id', async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete Invitation
app.delete('/api/invitations/:id', async (req, res) => {
    try {
        await Invitation.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Serve Frontend (Catch-all for SPA routes)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
