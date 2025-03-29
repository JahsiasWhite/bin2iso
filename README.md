# bin2iso-js

[![npm version](https://img.shields.io/npm/v/bin2iso-js?style=flat-square)](https://www.npmjs.com/package/bin2iso-js)

> Convert raw `.bin` CD-ROM images into valid `.iso` images — pure JavaScript port of [Bunnylin's bin2iso](https://gitlab.com/bunnylin/bin2iso) (C version)

---

## ✨ Features

- Converts raw `.bin` images to valid `.iso` format
- Lightweight and dependency-free
- CLI & library usage

---

## 📦 Installation

### Install from npm

```bash
npm install bin2iso-js
```

### Clone and run locally

```bash
git clone https://github.com/JahsiasWhite/bin2iso-js.git
cd bin2iso-js
npm install
```

## 🛠 Usage

### CLI

```bash
bin2iso-js input.bin output.iso
```

### Node.js

```js
import { convert } from 'bin2iso-js';

await convert('input.bin', 'output.iso');
```

## 🐇 Credits & Acknowledgements

This project is a partial port of the following bin2iso converters

- Original concept and implementation by **Bob Doiron** (bin2iso 1.x)
- Maintenance, improvements, and v2.0 by **Bunnylin / Kirinn** — [Original repo](https://gitlab.com/bunnylin/bin2iso)
