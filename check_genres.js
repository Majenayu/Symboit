const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const genreSchema = new mongoose.Schema({
    organizerEmail: String,
    title: String
});
const Genre = mongoose.model('Genre', genreSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const count = await Genre.countDocuments();
    console.log(`Total Genres in DB: ${count}`);
    
    const samples = await Genre.find().limit(5);
    console.log('Sample Genres (Organizer Emails):');
    samples.forEach(g => console.log(`- ${g.organizerEmail} (${g.title})`));
    
    process.exit(0);
}
check();
