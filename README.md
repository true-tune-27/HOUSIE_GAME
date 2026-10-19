# 🎲 Online Multiplayer Housie (Tambola) Game

A modern, real-time multiplayer Housie (Tambola/Bingo 90) web game built with **Node.js**, **Express**, **Socket.IO**, and **Vanilla JavaScript & CSS**. Designed for seamless mobile and desktop gameplay with rich animations, voice caller, payment QR verification, and automated prize claims!

---

## ✨ Features

- **Multiplayer Real-time Sync**: Synchronized number drawing, countdowns, board status, and player actions via WebSockets (Socket.IO).
- **Custom Ticket Allocation**:
  - Each ticket follows authentic Tambola rules (3 rows, 9 columns, 5 numbers per row, 15 unique numbers per ticket).
  - Players can choose and play up to **6 tickets** simultaneously.
  - Interactive daubing/marking on tickets with visual verification.
- **Voice Announcement (Caller)**:
  - Speech synthesis loudly announces each drawn number (e.g., *"Number 45 - Four Five"*).
  - Can be toggled on/off with audio feedback.
- **UPI / PhonePe Admin Payment Flow**:
  - Admin can upload their payment QR code (PhonePe/Google Pay/Paytm).
  - Players enter their name and transaction ID / UTR before joining.
  - Admin verifies and approves/rejects player entry in real time.
- **Configurable Prize Categories**:
  - **Early Five** (First 5 numbers marked across ticket)
  - **Top Line** (First row complete)
  - **Middle Line** (Second row complete)
  - **Bottom Line** (Third row complete)
  - **Four Corners** (The four outer corner numbers)
  - **Full House / Housie** (All 15 numbers marked)
  - Automatic server-side verification of claims with winning logs.
- **Admin Control Dashboard**:
  - Dedicated admin portal (`/admin.html`) with passcode protection.
  - Controls: Upload QR code, set prize amounts, start game, pause/resume, automatic or manual ball drawing, reset game.
  - Live player list, payment approvals, claim moderation, and audit logs.
- **Mobile Responsive & Safe-Area Aware**:
  - Fully responsive glassmorphism UI with gradient accents.
  - iOS safe-area support (`viewport-fit=cover`) and PWA-ready meta tags.

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or newer recommended)
- npm (comes with Node.js)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/true-tune-27/HOUSIE_GAME.git
   cd HOUSIE_GAME
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open your browser:
   - **Player Lobby / Game**: [http://localhost:3000](http://localhost:3000)
   - **Admin Dashboard**: [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, Socket.IO, Multer (QR code image uploads)
- **Frontend**: HTML5, Vanilla JavaScript, CSS3 (Modern Glassmorphism Design System)
- **Audio**: Web Speech API (`SpeechSynthesis`) & Web Audio API sound effects

---

## 📱 Mobile Friendly

Optimized for smartphones, tablets, and desktop displays with responsive touch controls, intuitive ticket navigation, and sticky player controls.

---

## 📜 License
MIT License. Free to use, modify, and distribute!
