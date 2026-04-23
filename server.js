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

const submissionSchema = new mongoose.Schema({
    studentEmail: String,
    organizerEmail: String,
    activityTitle: String,
    milestone: String, // "Week 1", "Week 2", "Full"
    driveFolderId: String,
    driveRootFolderId: String,
    files: [{
        name: String,
        driveFileId: String,
        viewLink: String
    }],
    status: { type: String, default: 'pending' },
    pointsAwarded: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model('Submission', submissionSchema);

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
        const users = await User.find(query).select('name email role driveRootFolderId');
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
    const { studentEmail, organizerEmail, activityTitle, milestone } = req.body;
    
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
                name: file.originalname,
                driveFileId: driveRes.data.id,
                viewLink: driveRes.data.webViewLink
            });
        }

        // 3. Store metadata in MongoDB (references only, no files)
        const submission = new Submission({
            studentEmail,
            organizerEmail,
            activityTitle,
            milestone,
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

// Get submissions for a Mentor to verify
app.get('/api/submissions', async (req, res) => {
    const { organizerEmail, studentEmail } = req.query;
    try {
        const query = { organizerEmail };
        if (studentEmail) query.studentEmail = studentEmail;
        
        const submissions = await Submission.find(query).sort({ submittedAt: -1 });
        res.json({ success: true, submissions });
    } catch (error) {
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

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
