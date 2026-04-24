const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const stream = require('stream');
const cron = require('node-cron');
const dotenv = require('dotenv');
const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const PDFDocument = require('pdfkit');
dotenv.config();

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

// Use candidate ID, but logic will handle failures
const GOOGLE_CLIENT_ID = '1026786000139-r37otcf7j25d15eqh08bai1hh8g1fgel.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files (d.html, dash.html, etc.)

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
    driveRootFolderId: String, // Store the main AICTE folder ID
    achievementFolderId: String, // Store the main Achievements folder ID
    participationFolderId: String, // Store the main Participation folder ID
    mentorEmail: String, // The mentor assigned to this student
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

const genreSchema = new mongoose.Schema({
    organizerEmail: String,
    title: String,
    desc: String,
    pts: Number,
    type: { type: String, enum: ['weeks', 'event'] }, // 2-week project vs 1-day event
    isRubric: { type: Boolean, default: false } // Priority Rubrics vs Regular Heads
});
const Genre = mongoose.model('Genre', genreSchema);

const submissionSchema = new mongoose.Schema({
    studentEmail: String,
    organizerEmail: String,
    activityTitle: String,
    milestone: String,
    eventDate: Date,
    submittedAt: { type: Date, default: Date.now },
    status: { type: String, default: 'pending' },
    pointsAwarded: { type: Number, default: 0 },
    files: [{ id: String, viewLink: String }]
});

const achievementSchema = new mongoose.Schema({
    studentEmail: String,
    organizerEmail: String,
    mentorEmail: String,
    genre: String,
    title: String,
    eventDate: Date,
    submittedAt: { type: Date, default: Date.now },
    status: { type: String, default: 'pending' },
    pointsAwarded: { type: Number, default: 0 },
    files: [{ id: String, viewLink: String }]
});

const Submission = mongoose.model('Submission', submissionSchema);
const Achievement = mongoose.model('Achievement', achievementSchema);

const participationSchema = new mongoose.Schema({
    studentEmail: String,
    organizerEmail: String,
    genre: String,
    title: String,
    eventDate: Date,
    files: [String], // Drive file IDs
    status: { type: String, default: 'pending' }, // pending, approved, rejected
    pointsAwarded: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now }
});
const Participation = mongoose.model('Participation', participationSchema);

const achievementGenreSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    isDefault: { type: Boolean, default: false }
});
const AchievementGenre = mongoose.model('AchievementGenre', achievementGenreSchema);

// Initialize Default Achievement Genres
async function initAchGenres() {
    const defaults = [
        "Hackathon", "NCC", "NSS", "Marathon", "Sports", "Paper Presentation", "Coding Contest", 
        "Robotics", "Cultural / Dance", "Music / Singing", "Internship", "Workshop", 
        "Certification", "Quiz", "Debate", "Photography", "Volunteering", 
        "Start-up / Innovation", "Entrepreneurship", "IEEE / CSI Events", "Project Exhibition"
    ];
    for (const name of defaults) {
        await AchievementGenre.updateOne({ name }, { $set: { name, isDefault: true } }, { upsert: true });
    }
}
initAchGenres().catch(e => console.error('Init AchGenres failed', e));

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
            // Check if this person was invited!
            const invitation = await Invitation.findOne({ email: payload.email, status: 'pending' });
            
            if (invitation) {
                user = new User({
                    googleId: payload.sub,
                    email: payload.email,
                    name: payload.name,
                    role: invitation.role,
                    organizerEmail: invitation.organizerEmail,
                    mentorEmail: invitation.inviterEmail, // Link to mentor
                    refreshToken: tokens.refresh_token // Capture for students too
                });
                invitation.status = 'accepted';
                await invitation.save();
            } else {
                // No invite? They are a new root Organizer
                user = new User({
                    googleId: payload.sub,
                    email: payload.email,
                    name: payload.name,
                    role: 'organizer',
                    organizerEmail: payload.email,
                    refreshToken: tokens.refresh_token
                });
            }
            await user.save();
        } else {
            // Existing user
            if (tokens.refresh_token) {
                user.refreshToken = tokens.refresh_token;
            }
        }

        // Initialize AICTE Folder for Students if missing
        if (user.role === 'student' && user.refreshToken && !user.driveRootFolderId) {
            try {
                const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
                oauth2Client.setCredentials({ refresh_token: user.refreshToken });
                const drive = google.drive({ version: 'v3', auth: oauth2Client });
                
                const folderId = await getDriveFolder(drive, 'AICTE');
                user.driveRootFolderId = folderId;

                // Share with Organizer & Mentor
                const shareWith = [user.organizerEmail];
                const mentorInvite = await Invitation.findOne({ email: user.email, status: 'accepted' });
                if (mentorInvite && mentorInvite.inviterEmail !== user.organizerEmail) {
                    shareWith.push(mentorInvite.inviterEmail);
                }

                for (const email of shareWith) {
                    await drive.permissions.create({
                        fileId: folderId,
                        requestBody: { type: 'user', role: 'writer', emailAddress: email },
                        fields: 'id'
                    }).catch(e => console.error('Initial folder share fail', e));
                }
                console.log(`[DRIVE] Initialized AICTE folder for student ${user.email}`);
            } catch (e) {
                console.error('[DRIVE] Failed to init student folder:', e);
            }
        }

        await user.save();
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
            // Check for invitation in Magic Login too
            const invitation = await Invitation.findOne({ email, status: 'pending' });
            
            if (invitation) {
                user = new User({
                    email,
                    name: email.split('@')[0],
                    role: invitation.role,
                    organizerEmail: invitation.organizerEmail
                });
                invitation.status = 'accepted';
                await invitation.save();
            } else {
                user = new User({
                    email,
                    name: email.split('@')[0],
                    role: 'organizer',
                    organizerEmail: email
                });
            }
            await user.save();
        } else if (user.role === 'organizer') {
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
        
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.get('host');
        const inviteLink = `${protocol}://${host}?invite=${token}`;
        
        console.log(`Invite generated for ${email}. Looking for organizer: ${organizerEmail}`);
        const organizer = await User.findOne({ email: organizerEmail });
        
        if (organizer && organizer.refreshToken) {
            console.log(`[MAIL] Attempting Gmail API delivery for ${email}`);
            
            const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
            oauth2Client.setCredentials({ refresh_token: organizer.refreshToken });

            try {
                const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
                
                // Construct the email in Base64 (Gmail API requirement)
                const subject = `Symboit Invitation – join as ${role}`;
                const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
                const messageParts = [
                    `From: Symboit System <${organizerEmail}>`,
                    `To: ${email}`,
                    'Content-Type: text/html; charset=utf-8',
                    'MIME-Version: 1.0',
                    `Subject: ${utf8Subject}`,
                    '',
                    `
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="UTF-8"></head>
                    <body style="margin:0; padding:0; background-color:#050505; font-family: 'Roboto', Arial, sans-serif;">
                        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#050505;">
                            <tr><td align="center">
                                <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">
                                    <tr><td style="padding:30px 20px; text-align:center;">
                                        <h1 style="margin:0; color:#6366f1; font-size:28px; letter-spacing:1px;">Symboit</h1>
                                    </td></tr>
                                    <tr><td style="background:#0b0b12; border-radius:12px; padding:40px 30px;">
                                        <h2 style="color:#ffffff; font-size:24px; margin:0 0 20px 0; text-align:center;">You are Invited to Join the Future of Learning</h2>
                                        <p style="color:#cfcfe6; font-size:15px; line-height:1.7; text-align:center;">
                                            You have been invited to join <b style="color:#ffffff;">Symboit</b> as a <b style="color:#10b981;">${role}</b>.
                                        </p>
                                        <table align="center" cellpadding="0" cellspacing="0" style="margin:30px auto;">
                                            <tr><td align="center">
                                                <a href="${inviteLink}" style="display:inline-block; padding:14px 28px; background:linear-gradient(90deg, #6366f1, #10b981); color:#ffffff; text-decoration:none; font-size:16px; font-weight:bold; border-radius:8px;">Accept Invitation</a>
                                            </td></tr>
                                        </table>
                                        <p style="color:#888; font-size:13px; text-align:center; margin-top:20px;">
                                            If the button does not work, copy and paste this link into your browser:<br>
                                            <span style="color:#6366f1;">${inviteLink}</span>
                                        </p>
                                    </td></tr>
                                    <tr><td style="padding:25px 20px; text-align:center;">
                                        <p style="color:#888; font-size:12px; margin:0;">Sent via Symboit AI Management System</p>
                                    </td></tr>
                                </table>
                            </td></tr>
                        </table>
                    </body>
                    </html>`
                ];
                const message = messageParts.join('\n');
                const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

                await gmail.users.messages.send({
                    userId: 'me',
                    requestBody: { raw: encodedMessage }
                });

                console.log(`[MAIL] Success: Email sent to ${email}`);
                res.json({ success: true, emailSent: true, inviteLink });

            } catch (mailError) {
                console.error('[MAIL] Gmail API Error:', mailError);
                res.json({ 
                    success: true, 
                    emailSent: false, 
                    error: `Mail API Error: ${mailError.message}`, 
                    inviteLink 
                });
            }
        } else {
            console.warn(`[MAIL] No Refresh Token for ${organizerEmail}`);
            res.json({ success: true, emailSent: false, error: 'No Gmail permissions found.', inviteLink });
        }
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
                organizerEmail: invitation.organizerEmail, // Inherit the tenant!
                mentorEmail: invitation.inviterEmail // Link to mentor
            });
        } else {
            user.role = invitation.role;
            user.organizerEmail = invitation.organizerEmail;
            user.mentorEmail = invitation.inviterEmail;
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
    const { role, organizerEmail, mentorEmail } = req.query;
    try {
        let query = { role };
        if (organizerEmail) query.organizerEmail = organizerEmail;
        
        if (mentorEmail && role === 'student') {
            // Find students who HAVE the field
            const hasField = await User.find({ ...query, mentorEmail });
            
            // FALLBACK: Find students who were invited by this mentor but DON'T have the field yet
            const invites = await Invitation.find({ inviterEmail: mentorEmail, role: 'student', status: 'accepted' });
            const invitedEmails = invites.map(i => i.email);
            
            const legacyStudents = await User.find({ 
                ...query, 
                email: { $in: invitedEmails },
                mentorEmail: { $exists: false } 
            });
            
            // Auto-heal legacy students for future faster queries
            if (legacyStudents.length > 0) {
                await User.updateMany(
                    { email: { $in: legacyStudents.map(s => s.email) } },
                    { $set: { mentorEmail: mentorEmail } }
                );
            }

            const allStudents = [...hasField, ...legacyStudents];
            // Remove duplicates if any
            const uniqueStudents = Array.from(new Map(allStudents.map(s => [s.email, s])).values());
            
            return res.json({ success: true, users: uniqueStudents });
        }

        if (mentorEmail) query.mentorEmail = mentorEmail;
        const users = await User.find(query).select('name email role driveRootFolderId mentorEmail');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Genre / Activity Config Endpoints ---

app.get('/api/genres', async (req, res) => {
    const { organizerEmail } = req.query;
    try {
        let genres = await Genre.find({ organizerEmail });
        
        // Seed defaults if empty
        if (genres.length === 0) {
            const defaults = [
                // Rubrics (isRubric: true, type: 'event')
                { title: "Plantation Drive", desc: "Mandatory plantation drive with geotagged photo evidence.", pts: 10, type: 'event', isRubric: true },
                { title: "Volunteering", desc: "General volunteering for academic and social activities.", pts: 10, type: 'event', isRubric: true },
                { title: "Workshops (External)", desc: "Full day workshops attended outside the institution.", pts: 10, type: 'event', isRubric: true },
                { title: "Blood Donation", desc: "Donor certificate required (claimable once).", pts: 10, type: 'event', isRubric: true },
                { title: "Outreach Activity", desc: "One day outreach programme for social causes.", pts: 10, type: 'event', isRubric: true },
                { title: "Hackathon", desc: "Participation in recognized technical hackathons.", pts: 10, type: 'event', isRubric: true },
                { title: "NSS Camps", desc: "One week attendance at NSS camps.", pts: 20, type: 'event', isRubric: true },
                { title: "Marathon/Cause", desc: "Participation in marathon/walkathon/cyclothon for a cause.", pts: 10, type: 'event', isRubric: true },
                
                // Activity Heads (isRubric: false, type: 'weeks')
                { title: "School Result Enhancement", desc: "Helping local schools achieve results and enhance enrollment.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Village Business Proposal", desc: "Preparing actionable business proposal for village income.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Sustainable Water Management", desc: "Developing water management systems.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Tourism Promotion", desc: "Innovative approaches to tourism.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Appropriate Technologies", desc: "Promotion of appropriate tech solutions.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Energy Consumption Reduction", desc: "Methods to reduce energy usage.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Rural Skilling", desc: "Skilling rural population for better livelihood.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Digitized Money Transactions", desc: "Facilitating 100% digital money usage.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Women Info Club", desc: "Setting up info clubs for women's economic issues.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Garbage Disposal System", desc: "Developing efficient garbage systems.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Rural Marketing Assistant", desc: "Assisting marketing of rural produce.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Food Preservation", desc: "Food preservation and packaging innovations.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Local Automation", desc: "Automation of local community activities.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Public Awareness (Outreach)", desc: "Spreading awareness under outreach programmes.", pts: 10, type: 'weeks', isRubric: false },
                { title: "National Level Initiatives", desc: "Contribution to Digital India, Skill India, Swachh Bharat etc.", pts: 10, type: 'weeks', isRubric: false },
                { title: "Rain Water Harvesting", desc: "Awareness regarding rain water harvesting.", pts: 10, type: 'weeks', isRubric: false }
            ];
            await Genre.insertMany(defaults.map(d => ({ ...d, organizerEmail })));
            genres = await Genre.find({ organizerEmail });
        }

        res.json({ success: true, genres });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/genres/reset', async (req, res) => {
    const { organizerEmail } = req.body;
    try {
        await Genre.deleteMany({ organizerEmail });
        // The next GET /api/genres will trigger the re-seed
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/genres', async (req, res) => {
    try {
        const genre = new Genre(req.body);
        await genre.save();
        res.json({ success: true, genre });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/genres/:id', async (req, res) => {
    try {
        const genre = await Genre.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, genre });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/genres/:id', async (req, res) => {
    try {
        await Genre.findByIdAndDelete(req.params.id);
        res.json({ success: true });
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
// --- AICTE Activity Submissions (Google Drive) ---

async function getDriveFolder(drive, name, parentId = null) {
    let query = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentId) query += ` and '${parentId}' in parents`;
    
    const res = await drive.files.list({ q: query, fields: 'files(id, name)' });
    if (res.data.files.length > 0) return res.data.files[0].id;

    const folderMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };
    const folder = await drive.files.create({
        resource: folderMetadata,
        fields: 'id'
    });
    return folder.data.id;
}

app.post('/api/submit-activity', upload.array('files'), async (req, res) => {
    const { studentEmail, organizerEmail, activityTitle, milestone, eventDate } = req.body;
    
    try {
        const student = await User.findOne({ email: studentEmail });
        if (!student || !student.refreshToken) {
            return res.status(400).json({ success: false, error: 'Student has not granted Drive permissions. Please logout and login again.' });
        }

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: student.refreshToken });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // 1. Ensure Folder Structure: AICTE -> [Activity Title] -> [Milestone]
        const aicteFolderId = await getDriveFolder(drive, 'AICTE');
        const activityFolderId = await getDriveFolder(drive, activityTitle, aicteFolderId);
        const milestoneFolderId = await getDriveFolder(drive, milestone || 'General', activityFolderId);

        // 2. Grant Permissions to Mentor and Organizer (if not already done)
        const shareWith = [organizerEmail];
        // Find mentor who invited this student to share with them too
        const mentorInvite = await Invitation.findOne({ email: studentEmail, status: 'accepted' });
        if (mentorInvite && mentorInvite.inviterEmail !== organizerEmail) {
            shareWith.push(mentorInvite.inviterEmail);
        }

        for (const email of shareWith) {
            await drive.permissions.create({
                fileId: aicteFolderId,
                requestBody: {
                    type: 'user',
                    role: 'writer', // Editor access
                    emailAddress: email
                },
                fields: 'id'
            }).catch(e => console.error(`Failed to share folder with ${email}`, e));
        }

        const uploadedFiles = [];

        // 2. Upload each file to the folder
        for (const file of req.files) {
            const bufferStream = new stream.PassThrough();
            bufferStream.end(file.buffer);

            const driveRes = await drive.files.create({
                requestBody: {
                    name: `${studentEmail.split('@')[0]}_${milestone}_${Date.now()}_${file.originalname}`,
                    parents: [milestoneFolderId]
                },
                media: {
                    mimeType: file.mimetype,
                    body: bufferStream
                },
                fields: 'id, webViewLink'
            });

            // FALLBACK: Grant permission to the FILE specifically as well
            for (const email of shareWith) {
                await drive.permissions.create({
                    fileId: driveRes.data.id,
                    requestBody: {
                        type: 'user',
                        role: 'writer',
                        emailAddress: email
                    },
                    fields: 'id'
                }).catch(e => console.error(`File share fail with ${email}`, e));
            }

            uploadedFiles.push({
                id: driveRes.data.id,
                viewLink: driveRes.data.webViewLink
            });
        }

        // 3. Store metadata in MongoDB (references only, no files)
        const submission = new Submission({
            studentEmail,
            organizerEmail,
            activityTitle,
            milestone,
            eventDate,
            driveFolderId: milestoneFolderId,
            driveRootFolderId: aicteFolderId,
            files: uploadedFiles
        });
        await submission.save();

        res.json({ success: true, submission });

    } catch (error) {
        console.error('[DRIVE] Upload Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get submissions for a Mentor or Organizer to verify
app.get('/api/submissions', async (req, res) => {
    const { organizerEmail, studentEmail, mentorEmail } = req.query;
    try {
        const query = { organizerEmail };
        if (studentEmail) {
            query.studentEmail = studentEmail;
        } else if (mentorEmail) {
            // Find students who HAVE the field
            const studentsWithField = await User.find({ mentorEmail, role: 'student' }).select('email');
            
            // Also find students who were invited by this mentor (fallback for legacy)
            const invites = await Invitation.find({ inviterEmail: mentorEmail, role: 'student', status: 'accepted' });
            
            const studentEmails = [
                ...studentsWithField.map(s => s.email),
                ...invites.map(i => i.email)
            ];
            
            query.studentEmail = { $in: [...new Set(studentEmails)] };
        }
        
        const submissions = await Submission.find(query).sort({ submittedAt: -1 });
        res.json({ success: true, submissions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/achievements', async (req, res) => {
    const { studentEmail, organizerEmail, mentorEmail } = req.query;
    try {
        let query = {};
        if (organizerEmail) query.organizerEmail = organizerEmail;
        if (studentEmail) {
            query.studentEmail = studentEmail;
        } else if (mentorEmail) {
            // Include students linked via mentorEmail field OR Invitation fallback
            const studentsWithField = await User.find({ mentorEmail, role: 'student' }).select('email');
            const invites = await Invitation.find({ inviterEmail: mentorEmail, role: 'student', status: 'accepted' });
            const studentEmails = [...new Set([...studentsWithField.map(s => s.email), ...invites.map(i => i.email)])];
            query.studentEmail = { $in: studentEmails };
        }
        const achievements = await Achievement.find(query).sort({ submittedAt: -1 });
        res.json({ success: true, achievements });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/submit-achievement', upload.array('files'), async (req, res) => {
    const { studentEmail, organizerEmail, genre, title, eventDate } = req.body;
    try {
        const student = await User.findOne({ email: studentEmail });
        if (!student || !student.refreshToken) return res.status(400).json({ success: false, error: 'Drive permissions missing.' });

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: student.refreshToken });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const date = new Date(eventDate);
        const y = date.getFullYear().toString();
        const m = (date.getMonth() + 1).toString().padStart(2, '0');
        const d = date.getDate().toString().padStart(2, '0');

        // Hierarchy: Achievements -> Genre -> Year -> Month -> Day
        const rootId = await getDriveFolder(drive, 'Achievements');
        const genreId = await getDriveFolder(drive, genre, rootId);
        const yearId = await getDriveFolder(drive, y, genreId);
        const monthId = await getDriveFolder(drive, m, yearId);
        const dayId = await getDriveFolder(drive, d, monthId);

        // Update User with Achievement Folder ID if missing
        if (!student.achievementFolderId) {
            await User.findByIdAndUpdate(student._id, { achievementFolderId: rootId });
        }

        const shareWith = [organizerEmail];
        const mentorInvite = await Invitation.findOne({ email: studentEmail, status: 'accepted' });
        if (mentorInvite && mentorInvite.inviterEmail !== organizerEmail) shareWith.push(mentorInvite.inviterEmail);

        for (const email of shareWith) {
            await drive.permissions.create({
                fileId: rootId,
                requestBody: { type: 'user', role: 'writer', emailAddress: email },
                fields: 'id'
            }).catch(() => {});
        }

        const uploadedFiles = [];
        for (const file of req.files) {
            const bufferStream = new stream.PassThrough();
            bufferStream.end(file.buffer);
            const driveRes = await drive.files.create({
                requestBody: { name: `${studentEmail.split('@')[0]}_${title}_${file.originalname}`, parents: [dayId] },
                media: { mimeType: file.mimetype, body: bufferStream },
                fields: 'id, webViewLink'
            });
            uploadedFiles.push({ id: driveRes.data.id, viewLink: driveRes.data.webViewLink });
        }

        const achievement = new Achievement({
            studentEmail, organizerEmail, mentorEmail: mentorInvite?.inviterEmail,
            genre, title, eventDate, files: uploadedFiles
        });
        await achievement.save();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/verify-achievement', async (req, res) => {
    const { id, status, rank } = req.body;
    try {
        const ach = await Achievement.findById(id);
        if(!ach) return res.status(404).json({ success: false, error: 'Achievement not found' });

        let pts = 0;
        if(status === 'approved') {
            if(rank === '1st Place') pts = 10;
            else if(rank === '2nd Place') pts = 7;
            else if(rank === '3rd Place') pts = 5;
            else pts = 3; // Special Prize

            // AUTO-CREATE PARTICIPATION (Achievement also counts as Participation)
            const existingPart = await Participation.findOne({ 
                studentEmail: ach.studentEmail, 
                genre: ach.genre, 
                eventDate: ach.eventDate,
                title: 'Participation (from Achievement)'
            });
            
            if(!existingPart) {
                const p = new Participation({
                    studentEmail: ach.studentEmail,
                    organizerEmail: ach.organizerEmail,
                    genre: ach.genre,
                    title: 'Participation (from Achievement)',
                    eventDate: ach.eventDate,
                    files: ach.files.map(f => f.id),
                    status: 'approved',
                    pointsAwarded: 10
                });
                await p.save();
            }
        }
        
        ach.status = status;
        ach.pointsAwarded = pts;
        await ach.save();
        
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/verify-participation', async (req, res) => {
    const { id, status } = req.body;
    try {
        await Participation.findByIdAndUpdate(id, { status, pointsAwarded: status === 'approved' ? 10 : 0 });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/participations', async (req, res) => {
    const { studentEmail, organizerEmail, mentorEmail } = req.query;
    try {
        let query = {};
        if (organizerEmail) query.organizerEmail = organizerEmail;
        if (studentEmail) query.studentEmail = studentEmail;
        else if (mentorEmail) {
            const studentsWithField = await User.find({ mentorEmail, role: 'student' }).select('email');
            const invites = await Invitation.find({ inviterEmail: mentorEmail, role: 'student', status: 'accepted' });
            const studentEmails = [...new Set([...studentsWithField.map(s => s.email), ...invites.map(i => i.email)])];
            query.studentEmail = { $in: studentEmails };
        }
        const participations = await Participation.find(query).sort({ submittedAt: -1 });
        res.json({ success: true, participations });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/submit-participation', upload.array('files'), async (req, res) => {
    const { studentEmail, organizerEmail, genre, title, eventDate } = req.body;
    try {
        const student = await User.findOne({ email: studentEmail });
        if (!student || !student.refreshToken) return res.status(400).json({ success: false, error: 'Drive permissions missing.' });

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: student.refreshToken });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const date = new Date(eventDate);
        const y = date.getFullYear().toString();
        const m = (date.getMonth() + 1).toString().padStart(2, '0');
        const d = date.getDate().toString().padStart(2, '0');

        const rootId = await getDriveFolder(drive, 'Participation');
        const genreId = await getDriveFolder(drive, genre, rootId);
        const yearId = await getDriveFolder(drive, y, genreId);
        const monthId = await getDriveFolder(drive, m, yearId);
        const dayId = await getDriveFolder(drive, d, monthId);

        if (!student.participationFolderId) {
            await User.findByIdAndUpdate(student._id, { participationFolderId: rootId });
        }

        const shareWith = [organizerEmail];
        const mentorInvite = await Invitation.findOne({ email: studentEmail, status: 'accepted' });
        if (mentorInvite && mentorInvite.inviterEmail !== organizerEmail) shareWith.push(mentorInvite.inviterEmail);

        for (const email of shareWith) {
            try {
                await drive.permissions.create({
                    fileId: rootId,
                    requestBody: { role: 'reader', type: 'user', emailAddress: email }
                });
            } catch (e) {}
        }

        const files = [];
        for (const file of req.files) {
            const response = await drive.files.create({
                requestBody: { name: file.originalname, parents: [dayId] },
                media: { mimeType: file.mimetype, body: Readable.from(file.buffer) }
            });
            files.push(response.data.id);
        }

        const p = new Participation({ studentEmail, organizerEmail, genre, title, eventDate, files });
        await p.save();
        res.json({ success: true, participation: p });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/achievement-genres', async (req, res) => {
    try {
        const genres = await AchievementGenre.find().sort({ name: 1 });
        res.json({ success: true, genres });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/achievement-genres', async (req, res) => {
    const { name } = req.body;
    try {
        const genre = new AchievementGenre({ name, isDefault: false });
        await genre.save();
        res.json({ success: true, genre });
    } catch (error) {
        if (error.code === 11000) return res.json({ success: true }); // Already exists
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify/Reject Submission
app.post('/api/verify-submission', async (req, res) => {
    const { id, status, points } = req.body;
    try {
        const sub = await Submission.findById(id);
        if (!sub) return res.status(404).json({ success: false, error: 'Submission not found' });
        
        sub.status = status;
        if (status === 'approved') sub.pointsAwarded = points || 10;
        await sub.save();
        
        res.json({ success: true, submission: sub });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk Email Notification for Mentor
app.post('/api/bulk-notify', async (req, res) => {
    const { mentorEmail, organizerEmail, message } = req.body;
    try {
        const students = await User.find({ organizerEmail, role: 'student' });
        const mentor = await User.findOne({ email: mentorEmail });
        
        if (!mentor || !mentor.refreshToken) return res.status(400).json({ success: false, error: 'Mentor permissions missing' });

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: mentor.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        for (const student of students) {
            const subject = 'Action Required: Symboit AICTE Update';
            const body = `
                <div style="font-family: sans-serif; background: #050505; color: white; padding: 30px; border-radius: 20px;">
                    <h2 style="color: #6366f1;">System Update Request</h2>
                    <p>Your mentor has requested an update on your AICTE activities.</p>
                    <p style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">${message || 'Please upload your latest progress photos and reports for the month.'}</p>
                    <a href="https://symboit-60sd.onrender.com/" style="display: inline-block; padding: 10px 20px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; margin-top: 20px;">Open Student Workspace</a>
                </div>`;

            const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
            const rawMsg = [
                `From: Symboit Mentor <${mentorEmail}>`,
                `To: ${student.email}`,
                'Content-Type: text/html; charset=utf-8',
                'MIME-Version: 1.0',
                `Subject: ${utf8Subject}`,
                '',
                body
            ].join('\n');

            const encoded = Buffer.from(rawMsg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
        }

        res.json({ success: true, count: students.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- AUTOMATED MONTHLY REMINDERS ---
// Runs on the 27th of every month at 9:00 AM (approx 4th day from end of month)
cron.schedule('0 9 27 * *', async () => {
    console.log('[CRON] Starting monthly student reminder broadcast...');
    const mentors = await User.find({ role: 'mentor', refreshToken: { $exists: true } });
    
    for (const mentor of mentors) {
        // Find their organization students
        const students = await User.find({ organizerEmail: mentor.organizerEmail, role: 'student' });
        if (students.length === 0) continue;

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: mentor.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        for (const student of students) {
            const rawMsg = [
                `From: Symboit System <${mentor.email}>`,
                `To: ${student.email}`,
                'Content-Type: text/html; charset=utf-8',
                'MIME-Version: 1.0',
                'Subject: Monthly AICTE Activity Reminder',
                '',
                `<div style="background:#050505; color:white; padding:40px; text-align:center; font-family:sans-serif;">
                    <h1 style="color:#6366f1;">Monthly Update Reminder</h1>
                    <p>This is an automated reminder to upload your activity photos and reports for this month.</p>
                    <p style="color:#94a3b8;">Keep your profile up to date to ensure timely degree completion.</p>
                    <br>
                    <a href="https://symboit-60sd.onrender.com/" style="padding:12px 25px; background:#10b981; color:white; text-decoration:none; border-radius:10px;">Upload Evidence Now</a>
                </div>`
            ].join('\n');

            const encoded = Buffer.from(rawMsg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } }).catch(e => console.error('Cron mail fail:', e));
        }
    }
});

// --- REPORT GENERATION ---

async function fetchDriveImage(drive, fileId) {
    try {
        console.log(`[REPORT] Fetching Drive image: ${fileId}`);
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        if (res && res.data) {
            return Buffer.from(res.data);
        }
        return null;
    } catch (e) {
        console.error(`[REPORT] Drive image fetch failed (${fileId}):`, e.message);
        return null;
    }
}

app.post('/api/report/generate', async (req, res) => {
    const { studentEmail, organizerEmail, type, startDate, endDate, format } = req.body;
    try {
        const student = await User.findOne({ email: studentEmail });
        if (!student || !student.refreshToken) return res.status(400).json({ success: false, error: 'Drive permissions missing.' });

        const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        oauth2Client.setCredentials({ refresh_token: student.refreshToken });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        let data = [];
        let reportTitle = "";
        
        if (type === 'aicte') {
            reportTitle = "AICTE Activity Points Report";
            data = await Submission.find({ 
                studentEmail, 
                status: 'approved',
                eventDate: { $gte: start, $lte: end }
            }).sort({ eventDate: 1 });
        } else if (type === 'ach') {
            reportTitle = "Achievement Node Report";
            data = await Achievement.find({ 
                studentEmail, 
                status: 'approved',
                eventDate: { $gte: start, $lte: end }
            }).sort({ eventDate: 1 });
        } else if (type === 'part') {
            reportTitle = "Participation Node Report";
            data = await Participation.find({ 
                studentEmail, 
                status: 'approved',
                eventDate: { $gte: start, $lte: end }
            }).sort({ eventDate: 1 });
        }

        if (data.length === 0) return res.status(404).json({ success: false, error: 'No approved records found in this range.' });

        if (format === 'docx') {
            const sections = [];
            
            for (const item of data) {
                const itemFiles = item.files || [];
                const photoBuffers = [];
                for (const f of itemFiles) {
                    const id = typeof f === 'string' ? f : (f.id || f.driveFileId);
                    if (!id) {
                        console.warn(`[REPORT] No ID found for file entry:`, f);
                        continue;
                    }
                    const buf = await fetchDriveImage(drive, id);
                    if (buf) {
                        photoBuffers.push(buf);
                    }
                }

                const children = [
                    // Header Table for perfect Name/Email alignment
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
                        rows: [
                            new TableRow({
                                children: [
                                    new TableCell({
                                        children: [new Paragraph({ children: [new TextRun({ text: student.name || studentEmail.split('@')[0], bold: true, size: 24 })] })],
                                    }),
                                    new TableCell({
                                        children: [new Paragraph({ children: [new TextRun({ text: studentEmail, size: 20 })], alignment: AlignmentType.RIGHT })],
                                    }),
                                ],
                            }),
                        ],
                    }),
                    new Paragraph({ text: "", spacing: { before: 200 } }),
                    new Paragraph({
                        children: [new TextRun({ text: reportTitle, bold: true, underline: {}, size: 32 })],
                        alignment: AlignmentType.CENTER,
                    }),
                    new Paragraph({ text: "", spacing: { before: 400 } }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Activity: ", bold: true }),
                            new TextRun({ text: item.activityTitle || item.title || item.genre }),
                        ],
                        spacing: { after: 100 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Date: ", bold: true }),
                            new TextRun({ text: new Date(item.eventDate).toLocaleDateString() }),
                        ],
                        spacing: { after: 100 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Points Awarded: ", bold: true }),
                            new TextRun({ text: (item.pointsAwarded || 10).toString() + " PTS" }),
                        ],
                        spacing: { after: 100 }
                    }),
                    new Paragraph({ text: "", spacing: { before: 200 } }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Description: ", bold: true }),
                            new TextRun({ text: "This activity confirms the student's involvement and verified contribution as per the institutional standards. The proof of work attached below has been reviewed and approved by the department mentor." }),
                        ],
                    }),
                    new Paragraph({ text: "", spacing: { before: 400 } }),
                ];

                if (photoBuffers.length > 0) {
                    if (photoBuffers.length === 1) {
                        children.push(new Paragraph({
                            children: [new ImageRun({ data: photoBuffers[0], transformation: { width: 450, height: 300 } })],
                            alignment: AlignmentType.CENTER
                        }));
                    } else {
                        const rows = [];
                        for (let j = 0; j < photoBuffers.length; j += 2) {
                            const cells = [
                                new TableCell({
                                    children: [new Paragraph({ children: [new ImageRun({ data: photoBuffers[j], transformation: { width: 220, height: 160 } })] }), new Paragraph({ text: "" })],
                                    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }
                                })
                            ];
                            if (photoBuffers[j+1]) {
                                cells.push(new TableCell({
                                    children: [new Paragraph({ children: [new ImageRun({ data: photoBuffers[j+1], transformation: { width: 220, height: 160 } })] }), new Paragraph({ text: "" })],
                                    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }
                                }));
                            }
                            rows.push(new TableRow({ children: cells }));
                        }
                        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows }));
                    }
                }

                sections.push({ children });
            }

            const doc = new Document({ sections });
            const buffer = await Packer.toBuffer(doc);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename=${type}_report.docx`);
            return res.send(buffer);

        } else if (format === 'pdf') {
            const doc = new PDFDocument({ margin: 40 });
            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            
            for (let i = 0; i < data.length; i++) {
                const item = data[i];
                if (i > 0) doc.addPage();

                // Header
                doc.fontSize(12).font('Helvetica-Bold').text(student.name || studentEmail.split('@')[0], 40, 40);
                doc.fontSize(10).font('Helvetica').text(studentEmail, 40, 40, { align: 'right' });
                doc.moveDown(2);

                // Title
                doc.fontSize(18).font('Helvetica-Bold').text(reportTitle, { align: 'center', underline: true });
                doc.moveDown(2);

                // Details
                doc.fontSize(10).font('Helvetica-Bold').text('Activity: ', { continued: true }).font('Helvetica').text(item.activityTitle || item.title || item.genre);
                doc.font('Helvetica-Bold').text('Date: ', { continued: true }).font('Helvetica').text(new Date(item.eventDate).toLocaleDateString());
                doc.font('Helvetica-Bold').text('Points Awarded: ', { continued: true }).font('Helvetica').text((item.pointsAwarded || 10).toString() + " PTS");
                doc.moveDown();
                doc.font('Helvetica-Bold').text('Description: ', { continued: true }).font('Helvetica').text("This activity confirms the student's involvement and verified contribution as per the institutional standards. The proof of work attached below has been reviewed and approved by the department mentor.");
                doc.moveDown(2);

                // Photos
                const itemFiles = item.files || [];
                const photoBuffers = [];
                for (const f of itemFiles) {
                    const id = typeof f === 'string' ? f : (f.id || f.driveFileId);
                    if (!id) {
                        console.warn(`[REPORT] No ID found for file entry:`, f);
                        continue;
                    }
                    const buf = await fetchDriveImage(drive, id);
                    if (buf) {
                        photoBuffers.push(buf);
                    }
                }

                if (photoBuffers.length > 0) {
                    const imgWidth = 220;
                    const imgHeight = 160;
                    let currentY = doc.y + 20;
                    
                    for (let j = 0; j < photoBuffers.length; j++) {
                        const col = j % 2;
                        const row = Math.floor(j / 2);
                        const x = 40 + col * (imgWidth + 20);
                        const y = currentY + row * (imgHeight + 20);
                        
                        // Prevent page overflow
                        if (y + imgHeight > doc.page.height - 40) {
                            doc.addPage();
                            currentY = 40; // Reset Y on new page
                        }

                        try {
                            doc.image(photoBuffers[j], x, y, { width: imgWidth, height: imgHeight });
                            // Advance doc.y if this is the last image or end of a row
                            if (j === photoBuffers.length - 1) {
                                doc.y = y + imgHeight + 20;
                            }
                        } catch (e) {
                            console.error(`[PDF] Image insert error for ${item.title}:`, e.message);
                            doc.fontSize(8).fillColor('red').text(`[Error: Image format not supported]`, x, y);
                            doc.fillColor('black');
                        }
                    }
                } else {
                    doc.fontSize(10).fillColor('gray').text('[No proof images attached/available]', { align: 'center' });
                    doc.fillColor('black');
                }
            }

            doc.end();
            
            doc.on('end', () => {
                const result = Buffer.concat(chunks);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=${type}_report.pdf`);
                res.send(result);
            });
            return;
        }

    } catch (error) {
        console.error('Report generation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
