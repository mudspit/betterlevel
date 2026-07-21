require('dotenv').config();

const accounts = [
  {
    id: 'gmail',
    name: 'Gmail',
    email: process.env.GMAIL_USER || 'mudspit@gmail.com',
    color: '#EA4335',
    icon: 'G',
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER || 'mudspit@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || '',
      },
    },
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER || 'mudspit@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || '',
      },
    },
  },
  {
    id: 'artxtreme-smartin',
    name: 'ArtXtreme (smartin)',
    email: process.env.DH1_USER || 'smartin@artxtreme.biz',
    color: '#FF6B35',
    icon: 'A',
    imap: {
      host: 'imap.dreamhost.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.DH1_USER || 'smartin@artxtreme.biz',
        pass: process.env.DH1_PASSWORD || '',
      },
    },
    smtp: {
      host: 'smtp.dreamhost.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.DH1_USER || 'smartin@artxtreme.biz',
        pass: process.env.DH1_PASSWORD || '',
      },
    },
  },
  {
    id: 'artxtreme-support',
    name: 'ArtXtreme (support)',
    email: process.env.DH2_USER || 'support@artxtreme.biz',
    color: '#F7931E',
    icon: 'A',
    imap: {
      host: 'imap.dreamhost.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.DH2_USER || 'support@artxtreme.biz',
        pass: process.env.DH2_PASSWORD || '',
      },
    },
    smtp: {
      host: 'smtp.dreamhost.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.DH2_USER || 'support@artxtreme.biz',
        pass: process.env.DH2_PASSWORD || '',
      },
    },
  },
  {
    id: 'mudpixel',
    name: 'MudPixel',
    email: process.env.DH3_USER || 'mud@mudpixel.com',
    color: '#8B5CF6',
    icon: 'M',
    imap: {
      host: 'imap.dreamhost.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.DH3_USER || 'mud@mudpixel.com',
        pass: process.env.DH3_PASSWORD || '',
      },
    },
    smtp: {
      host: 'smtp.dreamhost.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.DH3_USER || 'mud@mudpixel.com',
        pass: process.env.DH3_PASSWORD || '',
      },
    },
  },
  {
    id: 'mudspit',
    name: 'MudSpit',
    email: process.env.DH4_USER || 'smartin@mudspit.com',
    color: '#10B981',
    icon: 'M',
    imap: {
      host: 'imap.dreamhost.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.DH4_USER || 'smartin@mudspit.com',
        pass: process.env.DH4_PASSWORD || '',
      },
    },
    smtp: {
      host: 'smtp.dreamhost.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.DH4_USER || 'smartin@mudspit.com',
        pass: process.env.DH4_PASSWORD || '',
      },
    },
  },
];

module.exports = accounts;
