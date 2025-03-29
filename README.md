# bin2iso

[![npm version](https://img.shields.io/npm/v/bin2iso?style=flat-square)](https://www.npmjs.com/package/bin2iso)

Convert raw `.bin` CD-ROM images into valid `.iso` images — pure JavaScript port of [Bunnylin's bin2iso](https://gitlab.com/bunnylin/bin2iso) (C version)

---

## ✨ Features

- Converts raw `.bin` images to valid `.iso` format
- Lightweight and dependency-free
- CLI & library usage

---

## 📦 Installation

### Install from npm

```bash
npm install bin2iso
```

### Clone and run locally

```bash
git clone https://github.com/JahsiasWhite/bin2iso.git
cd bin2iso
npm install
```

## 🛠 Usage

### CLI

```bash
bin2iso input.bin output.iso
```

### Node.js

```js
import { convert } from 'bin2iso';

await convert('input.bin', 'output.iso');
```

## 🐇 Credits & Acknowledgements

This project is a partial port of the following bin2iso converters

- Original concept and implementation by **Bob Doiron** (bin2iso 1.x)
- Maintenance, improvements, and v2.0 by **Bunnylin / Kirinn** — [Original repo](https://gitlab.com/bunnylin/bin2iso)
