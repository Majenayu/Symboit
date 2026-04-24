const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const submissionSchema = new mongoose.Schema({
    studentEmail: String,
    status: String,
    activityTitle: String,
    files: [{ id: String, viewLink: String }]
});
const Submission = mongoose.model('Submission', submissionSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const samples = await Submission.find({ status: 'approved' });
    console.log('AICTE Records with File IDs:');
    samples.forEach(s => {
        console.log(`- Title: ${s.activityTitle}`);
        console.log(`  Files:`, JSON.stringify(s.files));
    });
    process.exit(0);
}
check();
