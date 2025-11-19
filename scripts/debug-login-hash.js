const bcrypt = require('bcryptjs');

const password = 'admin123';
const hash = '$2b$10$23jPbnMkmDoqX8Mpe8gzEeC46H4xm6k8qb2maS7AhTphgVlYKjJFS';

console.log('Testing password:', password);
console.log('Testing hash:', hash);

bcrypt.compare(password, hash).then(res => {
    console.log('Match result:', res);
}).catch(err => {
    console.error('Error:', err);
});
