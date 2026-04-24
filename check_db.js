const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const submissionSchema = new mongoose.Schema({
    studentEmail: String,
    status: String,
    eventDate: Date
});
const Submission = mongoose.model('Submission', submissionSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const count = await Submission.countDocuments({ status: 'approved' });
    const samples = await Submission.find({ status: 'approved' }).limit(5);
    console.log('Total Approved AICTE:', count);
    samples.forEach(s => {
        console.log(`Student: ${s.studentEmail}, Date: ${s.eventDate}`);
    });
    process.exit(0);
}
check();
