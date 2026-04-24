const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const achievementSchema = new mongoose.Schema({
    studentEmail: String,
    status: String,
    eventDate: Date
});
const Achievement = mongoose.model('Achievement', achievementSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const count = await Achievement.countDocuments({ status: 'approved' });
    const samples = await Achievement.find({ status: 'approved' }).limit(5);
    console.log('Total Approved Achievements:', count);
    samples.forEach(s => {
        console.log(`Student: ${s.studentEmail}, Date: ${s.eventDate}`);
    });
    process.exit(0);
}
check();
