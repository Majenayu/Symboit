const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    role: String
});
const User = mongoose.model('User', userSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const u = await User.findOne({ name: /AYUSH/i });
    if (u) {
        console.log(`Found User: ${u.name}`);
        console.log(`Email: ${u.email}`);
        console.log(`Role: ${u.role}`);
    } else {
        console.log('User not found');
    }
    process.exit(0);
}
check();
