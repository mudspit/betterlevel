// Copy this file to accounts.js and fill in your credentials
// Or use a .env file — the env vars take priority over the hardcoded fallbacks
require('dotenv').config();

const accounts = [
  {
    id: 'gmail',
    name: 'Gmail',
    email: process.env.GMAIL_USER || 'you@gmail.com',
    color: '#EA4335',
    icon: 'G',
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER || 'you@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || 'your-app-password',
      },
    },
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER || 'you@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || 'your-app-password',
      },
    },
  },
  // Add more accounts below — copy/paste this block and change the fields:
  // {
  //   id: 'dreamhost-1',
  //   name: 'My Domain (user)',
  //   email: 'user@yourdomain.com',
  //   color: '#FF6B35',
  //   icon: 'D',
  //   imap: { host: 'imap.dreamhost.com', port: 993, secure: true,
  //     auth: { user: 'user@yourdomain.com', pass: 'password' } },
  //   smtp: { host: 'smtp.dreamhost.com', port: 587, secure: false,
  //     auth: { user: 'user@yourdomain.com', pass: 'password' } },
  // },
];

module.exports = accounts;
