const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://majen:majen@majen.f3jgom3.mongodb.net/symb?appName=majen';

const genreSchema = new mongoose.Schema({
    organizerEmail: String,
    title: String
});
const Genre = mongoose.model('Genre', genreSchema);

async function check() {
    await mongoose.connect(MONGODB_URI);
    const count = await Genre.countDocuments({ organizerEmail: 'pgayushrai@gmail.com' });
    console.log(`Genres for pgayushrai@gmail.com: ${count}`);
    process.exit(0);
}
check();
