// #include <stdio.h>
// #include <string.h>
// #include <stdlib.h>
// #include <stdbool.h>
// #include <stdint.h>
// #include <unistd.h>
// #include <dirent.h>
// #include <ctype.h>
// #include "getopt.h"

const VERSIONSTR= "V2.0";

//----------------Wave Stuff---------------------/
class WavHdr {
	constructor() {
	  this.riff = new Uint8Array(4);
	  this.bytesToEnd = 0;
	  this.waveTxt = new Uint8Array(4);
	  this.fmtTxt = new Uint8Array(4);
	  this.formatSize = 0; // 16 byte format specifier
	  this.format = 0; // Windows PCM
	  this.channels = 0; // 2 channels
	  this.sampleRate = 0; // 44,100 Samples/sec
	  this.avgByteRate = 0; // 176,400 Bytes/sec
	  this.sampleBytes = 0; // 4 bytes/sample
	  this.channelBits = 0; // 16 bits/channel
	  this.dataTxt = new Uint8Array(4);
	  this.blockSize = 0;
	}
} //tWavHead

const HEADBYTES = 36
const WINDOWS_PCM = 0x0001
//-------------------------------------------------/

const MAXIMUM_TRACK_NUMBERS = 100

const SIZERAW = 2352;
const syncPattern = new Uint8Array([
  0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0,
]);
const isoVolumeDescriptor = new Uint8Array([
  0x01,
  'C'.charCodeAt(0),
  'D'.charCodeAt(0),
  '0'.charCodeAt(0),
  '0'.charCodeAt(0),
  '1'.charCodeAt(0),
  0x01,
  0x00,
]); // CDs
const udfVolumeDescriptor = new Uint8Array([
  0x00,
  'B'.charCodeAt(0),
  'E'.charCodeAt(0),
  'A'.charCodeAt(0),
  '0'.charCodeAt(0),
  '1'.charCodeAt(0),
  0x01,
  0x00,
]); // DVDs

// #pragma pack(push, 1) // tell compiler not to add alignment padding here
class IsoHdr {
	constructor() {
	  this.type = 0;
	  this.signature = new Uint8Array(5);
	  this.version = 0;
	  this.reserved = 0;
	  this.systemId = new Uint8Array(32);
	  this.volumeId = new Uint8Array(32);
	  this.unused = new Uint8Array(8);
	  this.volumeBlockCountLSB = 0;
	  this.volumeBlockCountMSB = 0;
	  this.stuff = new Uint8Array(40);
	  this.logicalBlockSizeLSB = 0;
	  this.logicalBlockSizeMSB = 0;
	  this.moreStuff = new Uint8Array(1916);
	}
  } // tIsoDescriptor
// #pragma pack(pop)

// Bin2iso internal track modes.
const MODE_AUDIO = 0;
const MODE_AUDIOSUB = 10; // subchannel data in audio!?
const MODE1_2352 = 20;
const MODE1_2048 = 30;
const MODE1_2448 = 40;
const MODE2_2352 = 50;
const MODE2_2336 = 60;
const MODE2_2448 = 70;

// got this from easycd pro by looking at a blank disk so it may be off...
const CD74_MAX_SECTORS = 334873; // 653.75 Mb

class CommandlineOptions {
  constructor() {
    this.oneTrackNum = 0;
    this.splitRmsLimit = 0;
    this.splitGapLength = 0;
    this.noOverburn = false;
    this.noGaps = false;
    this.autoGaps = false;
    this.allPostGaps = false;
    this.createCue = false;
    this.doOneTrack = false;
    this.doInPlace = false;
    this.outputDir = '';
    this.sBinFilename = '';
    this.sCueFilename = '';
  }
}

// global variables
FILE* fdOutFile;
let cueDirectory = '';

// Best buffer size varies by machine, 1-4Mb generally best. 2Mb write worked best on my machine.
// I also tried doing direct fwrites instead of buffering, but that was slightly slower somehow.
// There are cache buffers at hardware, OS, clib implementation, and CPU level, so it's not useful
// to spend much time optimising the buffer size here. I saw differences in the 1-2% range only.
const OUTBUF_SIZE = 2 * 1024 * 1024;
const INBUF_SIZE = 4 * 1024 * 1024;
const outBuf = new Uint8Array(OUTBUF_SIZE);
let outBufIndex = 0;
const inBuf = new Uint8Array(INBUF_SIZE);
let inBufReadIndex = 0;
let inBufWriteIndex = 0;

let writePos = 0; // for inplace conversions...

class Track {
	constructor() {
	  this.mode = 0;
	  this.num = 0;
	  this.idx0 = 0; // sector index for start of pregap
	  this.idx1 = 0; // sector index for start of data
	  this.startOfs = 0; // byte offset for start of data, optionally including pregap
	  this.totalSectors = 0;
	  this.sectorSize = 0; // always 2352 on physical CDs, sometimes less (or more!) on disk images
	  this.predata = 0;
	  this.postdata = 0; // size of metadata before and after the extractable user data
	  this.fdSrcFile = null;
	  this.sSrcFileName = '';
	  this.name = ''; // srcfilename + "-xx.ext"
	}
} // tTrack

const tracks = new Array(MAXIMUM_TRACK_NUMBERS)
  .fill(null)
  .map(() => new Track());
let nTracks = 0;

function strcpylower(out_str, in_str) {
    let i = 0;
    while (in_str[i] !== undefined) {
        out_str[i] = in_str[i].toLowerCase();
        i++;
    }
    out_str[i] = '';
}

function getFileSize(file) {
    if (file.seek(0, 'end') !== 0) {
        console.error("bin2iso(fseek)");
        process.exit(1);
    }
    return file.tell();
}


function openCaseless(filename) {
    // If using a CUE file outside the current working directory, presumably BIN files are next
    // to the CUE so go to that directory temporarily.
    const cwd = process.cwd();
    if (cueDirectory !== '') {
        try {
            process.chdir(cueDirectory);
        } catch (err) {
            console.error("bin2iso(chdir)", err);
            process.exit(1);
        }
    }

    const filemode = options.doInPlace ? 'r+' : 'r';
    let fd = null;

    try {
        fd = fs.openSync(filename, filemode);
    } catch (err) {
        // If not found at exact casing, look for a variant-case file.
        const dir = fs.opendirSync('.');
        const namelen = filename.length;
        const lowname = filename.toLowerCase();

        let entry;
        while ((entry = dir.readSync()) !== null) {
            const entrylen = entry.name.length;
            if (entrylen !== namelen) continue;
            const newname = entry.name.toLowerCase();
            if (lowname === newname) {
                try {
                    fd = fs.openSync(entry.name, filemode);
                    break;
                } catch (err) {
                    // Ignore error and continue searching
                }
            }
        }
        dir.closeSync();

        if (fd === null) {
            console.error("bin2iso(fopen)");
            console.log(`Error: Unable to open "${filename}"`);
            process.exit(1);
        }
    }

    if (cueDirectory !== '') {
        try {
            process.chdir(cwd);
        } catch (err) {
            console.error("bin2iso(chdir)", err);
            process.exit(1);
        }
    }

    return fd;
}

// The INDEX mm:ss:ff values point at a sector index denominated in a way friendly to CD audio.
// There are 75 frames to one second.
// 44100 Hz 16-bit stereo audio uses 44100 * 2 * 2 = 176400 bytes per second.
// Therefore the raw sector size per frame is 176400 / 75 = 2352 bytes.
// Example: time index 00:02:50
//   2 * 75 + 50 = sector index 200
//   2352 * 200 = byte offset 470400

function SectorIndex(m, s, f)
{
	let temp;

	temp = (((m >> 4) * 10) + (m & 0xF)) * 60;
	temp = (temp + (((s >> 4) * 10) + (s & 0xF))) * 75;
	temp = temp + (((f >> 4) * 10) + (f & 0xF));

	//printf("\n%d%d %d%d %d%d = %06d", m >> 4, m & f, s >> 4, s & f, f >> 4, f & f, temp);
	return temp;
}

function TimeIndex(sectorindex, ptr)
{
	let m, s, f;

	f = (uint8_t) (sectorindex % 75);
	s = (uint8_t) ((sectorindex / 75) % 60);
	m = (uint8_t) (sectorindex / (75 * 60));
	sprintf(ptr, "%d%d:%d%d:%d%d", m / 10, m % 10, s / 10, s % 10, f / 10, f % 10);
}

function BufferedFRead(readptr, readsize, srcfile) {
    if (inBufReadIndex >= inBufWriteIndex) {
        // No more unread data in buffer, get more from file.
        inBufWriteIndex = srcfile.read(inBuf, 0, INBUF_SIZE - INBUF_SIZE % readsize);
        if (inBufWriteIndex === 0) {
            return false; // read failed, or end of file
        }
        inBufReadIndex = 0;
    }

    readptr[0] = inBuf.slice(inBufReadIndex);

    inBufReadIndex += readsize;
    if (inBufReadIndex > inBufWriteIndex) {
        console.warn("Warning: Premature EOF");
        inBuf.fill(0, inBufWriteIndex, inBufReadIndex);
    }

    return true; // read passed
}

function BufferedFWrite(srcptr, size, fdBinFile) {
    // Assert: size is always less than OUTBUF_SIZE.
    if (outBufIndex + size > OUTBUF_SIZE) {
        let readpos = 0;
        if (fdOutFile === fdBinFile) { // reading and writing same file in place
            readpos = fdOutFile.tell(); // Assuming fdOutFile is a file-like object with a tell method
            if (fdOutFile.seek(writePos) !== 0) {
                console.error("\nbin2iso(fseek)");
                process.exit(1);
            }
        }

        if (fdOutFile.write(outBuf.slice(0, outBufIndex)) !== 1) {
            console.error("\nbin2iso(fwrite)");
            fdOutFile.close();
            process.exit(1);
        }
        outBufIndex = 0;

        if (fdOutFile === fdBinFile) {
            writePos = fdOutFile.tell();
            if (fdOutFile.seek(readpos) !== 0) {
                console.error("\nbin2iso(fseek)");
                process.exit(1);
            }
        }
    }

    outBuf.set(new Uint8Array(srcptr.buffer, srcptr.byteOffset, size), outBufIndex);
    outBufIndex += size;
}



void FlushBuffers(FILE* fdBinFile)
{
	let readpos = 0;

	if (fdOutFile == fdBinFile) // reading and writing same file in place
	{
		readpos = ftell(fdOutFile);
		if (0 != fseek(fdOutFile, writePos, SEEK_SET))
		{
			perror("\nbin2iso(fseek)");
			exit(1);
		}
	}

	if ((outBufIndex != 0) && (1 != fwrite(outBuf, outBufIndex, 1, fdOutFile)))
	{
		perror("\nbin2iso(fwrite)");
		fclose(fdOutFile);
		exit(1);
	}

	outBufIndex = 0;
	inBufReadIndex = 0;
	inBufWriteIndex = 0;

	if (fdOutFile == fdBinFile)
	{
		writePos = ftell(fdOutFile);
		if (0 != fseek(fdOutFile, readpos, SEEK_SET))
		{
			perror("\nbin2iso(fseek)");
			exit(1);
		}
	}
}

void DoTrack(track)
{
	let fdBinFile = track.fdSrcFile;
	uint8_t* buffer; // this is a pointer to somewhere in inBuf, for zero-copy reads
	let remainingsectors = track.totalSectors;

	let sOutFilename;
	strcpy(sOutFilename, options.outputDir);
	strcat(sOutFilename, track.name);

	printf("Writing %s (", sOutFilename);

	// In 2352-byte modes, there's some metadata in each sector that needs to be skipped when
	// copying the user data.
	// See: https://en.wikipedia.org/wiki/CD-ROM
	// In 2048-byte mode, all metadata is already omitted, copy to output directly.
	// Mode2/2336 is special: this is Mode2/Form1 except the first 16 bytes are omitted. This
	// means the sync pattern is not present, but the subheader and ECC stuff is there. Sectors
	// are saved as 2336 bytes each, including the usual 2048 bytes of user data.
	switch (track.mode)
	{
		case MODE_AUDIO:
			printf("Audio");
			break;
		case MODE_AUDIOSUB:
			printf("Audio with subchannel data");
			break;
		case MODE1_2352:
			printf("Mode1/2352");
			break;
		case MODE1_2048:
			printf("Mode1/2048");
			break;
		case MODE1_2448:
			printf("Mode1/2448");
			break;
		case MODE2_2352:
			printf("Mode2/2352");
			break;
		case MODE2_2336:
			printf("Mode2/2336");
			break;
		default:
			printf("Unexpected mode!");
			exit(1);
	}
	printf("): ");
	let datasize = track.sectorSize - track.predata - track.postdata;

	fdOutFile = fopen(sOutFilename, "wb");
	if (fdOutFile == NULL)
	{
		perror("bin2iso(fopen)");
		printf("Unable to create \"%s\"\n", sOutFilename);
		exit(1);
	}

	if (track.mode == MODE_AUDIO || track.mode == MODE_AUDIOSUB)
	{
		let totalsize = track.totalSectors * SIZERAW;
		// let wavhead =
		// {
		// 	"RIFF",
		// 	totalsize + HEADBYTES, // bytesToEnd
		// 	"WAVE",
		// 	"fmt ",
		// 	16,          // 16 byte format specifier
		// 	WINDOWS_PCM, // format
		// 	2,           // 2 Channels
		// 	44100,       // 44,100 Samples/sec
		// 	176400,      // 176,400 Bytes/sec
		// 	4,           // 4 bytes/sample
		// 	16,          // 16 bits/channel
		// 	"data",
		// 	totalsize
		// };
		// TODO
		const wavhead = {
			chunkID: "RIFF",
			chunkSize: totalsize + HEADBYTES, // bytesToEnd
			format: "WAVE",
			subchunk1ID: "fmt ",
			subchunk1Size: 16,          // 16 byte format specifier
			audioFormat: WINDOWS_PCM,   // format
			numChannels: 2,             // 2 Channels
			sampleRate: 44100,         // 44,100 Samples/sec
			byteRate: 176400,           // 176,400 Bytes/sec
			blockAlign: 4,              // 4 bytes/sample
			bitsPerSample: 16,          // 16 bits/channel
			subchunk2ID: "data",
			subchunk2Size: totalsize
		};

		if (1 !== fs.writeSync(fdOutFile, wavhead)) {
			console.error("bin2iso(fwrite)");
			fs.closeSync(fdOutFile);
			process.exit(1);
		}
	}

	if (0 !== fs.seekSync(fdBinFile, track.startOfs, 'SET')) {
		console.error("bin2iso(fseek)");
		process.exit(1);
	}

	while (remainingsectors-- !== 0 && BufferedFRead(buffer, track.sectorSize, fdBinFile)) {
		BufferedFWrite(buffer.slice(track.predata), datasize, fdBinFile);
	}

	FlushBuffers(fdBinFile);
	console.log("OK");

	fs.closeSync(fdOutFile);
	fs.closeSync(fdBinFile);
}

// TODO THIS WHOLE FUNCTION
tTrack* ParseCueLine(char* readp, char* activefile, tTrack* track)
{
	// For reference:
	// https://www.gnu.org/software/ccd2cue/manual/html_node/CUE-sheet-format.html#CUE-sheet-format
	// https://kodi.wiki/view/Cue_sheets

	// Skip leading spaces. Usually there's an exact amount of whitespace for each command, but
	// some CUE file generators produce fewer or more spaces. Should skip tab too?..
	// TODO
	while (readp === ' ' || readp === '\n' || readp === '\r') readp++;
	if (readp === '\0') return track; // empty line

	// FILE "<filename>" <MODE>
	// The filename might include an absolute or relative directory, but usually is just the file.
	// Filename is usually in quotes, but they can be omitted if it has no spaces.
	// Mode is usually BINARY, but could be WAVE, AIFF, MP3. Also MOTOROLA for big-endian binary.
	// We only want the filename, ignore the mode.
	// TODO
	if (readp.startsWith("FILE ")) {
		readp += 5;
		while (readp[0] == ' ') readp = readp.slice(1);; // just in case

		let writep = activefile;
		let terminator = ' ';

		for (let i = 0; i < readp.length; i++) {
			const char = readp[i];
	
			switch (char.charCodeAt(0)) {
				case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 9: case 10:
				case 11: case 12: case 13: case 14: case 15: case 16: case 17: case 18: case 19:
				case 20: case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 28:
				case 29: case 30: case 31:
					// Ignore unexpected control characters silently.
					break;
	
				case '/':
				case '\\':
					// Just ignore anything to the left of every path separator.
					// Technically incorrect, but directory references in CUE files are invalid
					// more often than not...
					writep = activefile;
					break;
	
				case '"'.charCodeAt(0):
					terminator = '"';
					break;
	
				default:
					writep += char;
					break;
			}
		}

		if (terminator == '"' && readp != '"')
		{
			printf("Error: Unpaired \" in 'FILE' in cuefile %s\n", options.sCueFilename);
			exit(1);
		}

		if (writep == activefile)
		{
			printf("Error: Empty name for 'FILE' in cuefile %s\n", options.sCueFilename);
			exit(1);
		}
		// *writep = '\0';
		activefile = writep;
		track = null;
	}

	// TRACK <number> <DATATYPE>
	// The index number should be in the 1..99 range, and unique within this CUE file.
	// The number doesn't have to have a leading 0. It should grow by +1 for each new track.
	// The track's source FILE context must have appeared already.
	// DATATYPE is AUDIO or one of several binary data descriptors.
	else if (strncmp(readp, "TRACK ", 6) == 0)
	{
		readp += 6;
		// while (*readp == ' ') readp++;
		while (readp[0] === ' ') readp++;

		if (nTracks >= MAXIMUM_TRACK_NUMBERS)
		{
			printf("Error: Too many tracks in cuefile %s\n", options.sCueFilename);
			exit(1);
		}

		track = tracks[nTracks++];
		track.idx0 = -1;
		track.idx1 = -1;
		track.sectorSize = SIZERAW;
		track.predata = 0;
		track.postdata = 0;

		if (activefile[0] == '\0')
		{
			printf("Error: TRACK before FILE in cuefile %s\n", options.sCueFilename);
			exit(1);
		}
		strcpy(track.sSrcFileName, activefile);
		track.fdSrcFile = OpenCaseless(activefile);

		// Read the index number straight into track.num, use numstr to refer back to this index.
		let numstr = readp;
		track.num = 0;
		while (readp.charAt(0) >= '0' && readp.charAt(0) <= '9') {
			track.num = track.num * 10 + (parseInt(readp.charAt(0)) - parseInt('0'));
			readp = readp.slice(1);
		}
		readp = '\0' + readp.slice(1); // numstr terminator
		while (readp.charAt(0) === ' ') {
			readp = readp.slice(1);
		}


		// Regarding modes - https://en.wikipedia.org/wiki/CD-ROM
		// CD sectors always contains 2352 bytes. Depending on mode, part of that space is used
		// for error check values or other metadata. But when calculating the data start offset
		// for any track, the sector index is always multiplied by 2352.
		// However, a disk image may be saved with an unusual sector size, omitting part of the
		// physical 2352 bytes, or including subchannel data to go above 2352 bytes.
		if (strncmp(readp, "AUDIO/", 6) == 0) track.mode = MODE_AUDIOSUB;
		else if (strncmp(readp, "AUDIO", 5) == 0) track.mode = MODE_AUDIO;
		else if (strncmp(readp, "MODE1/2352", 10) == 0) track.mode = MODE1_2352;
		else if (strncmp(readp, "MODE1/2048", 10) == 0) track.mode = MODE1_2048;
		else if (strncmp(readp, "MODE1/2448", 10) == 0) track.mode = MODE1_2448;
		else if (strncmp(readp, "MODE2/2352", 10) == 0) track.mode = MODE2_2352;
		else if (strncmp(readp, "MODE2/2336", 10) == 0) track.mode = MODE2_2336;
		else if (strncmp(readp, "MODE2/2448", 10) == 0) track.mode = MODE2_2448;
		else
		{
			printf("Error: Track %s - Unknown mode: [%s]\n", numstr, readp);
			exit(1);
		}

		switch (track.mode)
		{
			case MODE_AUDIOSUB:
				track.sectorSize = strtol(readp + 6, NULL, 10);
				if (track.sectorSize > SIZERAW)
					track.postdata = track.sectorSize - SIZERAW;
				break;
			case MODE1_2048:
				track.sectorSize = 2048;
				break;
			case MODE1_2352:
				track.predata = 16;
				track.postdata = 288;
				break;
			case MODE2_2336:
				track.sectorSize = 2336;
				track.predata = 8;
				track.postdata = 280;
				break;
			case MODE2_2352:
				track.predata = 24;
				track.postdata = 280;
				break;
			case MODE1_2448:
				track.sectorSize = 2448;
				track.predata = 16;
				track.postdata = 384;
				break;
			case MODE2_2448:
				track.sectorSize = 2448;
				track.predata = 24;
				track.postdata = 376;
				break;
		}

		// Build the name: <source file without extension>-<track index>.<wav or iso>
		track.name = track.sSrcFileName;
		let extp = track.name.lastIndexOf('.');
		if (extp !== -1) {
			track.name = track.name.substring(0, extp);
		}
		track.name += "-";
		track.name += numstr;

		if (track.mode == MODE_AUDIO || track.mode == MODE_AUDIOSUB)
			strcat(track.name, ".wav");
		else
			strcat(track.name, ".iso");
	}

	// INDEX <number> <mm:ss:ff>
	// The index number is 0 for pre-gap start, 1 for actual data start. What if 2 or greater?
	// The number doesn't have to have a leading 0.
	// The index's source TRACK context must have appeared already.
	// The time value is a time-encoded offset relative to the start of the FILE, which converts
	// to a sector index.
	else if (strncmp(readp, "INDEX ", 6) == 0)
	{
		readp = readp.slice(6);
    	while (readp.charAt(0) === ' ') readp = readp.slice(1);

		if (track == NULL)
		{
			printf("Error: INDEX without active TRACK cuefile %s\n", options.sCueFilename);
			exit(1);
		}

		let numstr = readp;
		let i = 0;
		while (readp.charAt(0) >= '0' && readp.charAt(0) <= '9') {
			i = i * 10 + (readp.charCodeAt(0) - '0'.charCodeAt(0));
			readp = readp.slice(1);
		}

		if (i >= 2)
		{
			readp = '\0';
			printf("Error: Unexpected INDEX number: %s\n", numstr);
			// Maybe should just warn, return, and keep going?
			exit(1);
		}

		while (readp.charAt(0) === ' ') readp = readp.slice(1);

		let min = ((readp.charCodeAt(0) - '0'.charCodeAt(0)) << 4) | (readp.charCodeAt(1) - '0'.charCodeAt(0));
		let sec = ((readp.charCodeAt(3) - '0'.charCodeAt(0)) << 4) | (readp.charCodeAt(4) - '0'.charCodeAt(0));
		let frame = ((readp.charCodeAt(6) - '0'.charCodeAt(0)) << 4) | (readp.charCodeAt(7) - '0'.charCodeAt(0));

		if (i == 0)
		{
			if (track.mode != MODE_AUDIO && track.mode != MODE_AUDIOSUB)
			{
				printf("Error: Index 0 pregap defined on non-audio track %d\n", track.num);
				exit(1);
			}
			track.idx0 = SectorIndex(min, sec, frame);
			if (track.idx1 == -1) track.idx1 = track.idx0;
		}
		else
		{
			track.idx1 = SectorIndex(min, sec, frame);
			if (track.idx0 == -1) track.idx0 = track.idx1;
		}
	}

	// The pre- and postgap commands supposedly are there to request an artificial gap be added,
	// which is not actually in the source data. Let's ignore those...
	else if (strncmp(readp, "PREGAP ", 7) == 0) { ; }
	else if (strncmp(readp, "POSTGAP ", 8) == 0) { ; }
	// Other functionally uninteresting commands, ignore.
	else if (strncmp(readp, "CDTEXTFILE ", 11) == 0) { ; }
	else if (strncmp(readp, "SONGWRITER ", 11) == 0) { ; }
	else if (strncmp(readp, "PERFORMER ", 10) == 0) { ; }
	else if (strncmp(readp, "CATALOG ", 8) == 0) { ; }
	else if (strncmp(readp, "FLAGS ", 6) == 0) { ; }
	else if (strncmp(readp, "TITLE ", 6) == 0) { ; }
	else if (strncmp(readp, "ISRC ", 5) == 0) { ; }
	else if (strncmp(readp, "REM ", 4) == 0) { ; }

	else
	{
		printf("Unrecognised line in CUE: \"%s\"\n", readp);
	}

	return track;
}

function ParseCue()
{
	const fdCueFile = fs.openSync(options.sCueFilename, 'r');
	if (fdCueFile === null) {
		console.error("bin2iso(fopen)");
		console.log(`Error: Unable to open "${options.sCueFilename}"`);
		process.exit(1);
	}

	let sLine = '';
	let currentfile = '';
	let currenttrack = null;

	// Extract directory from cue path, removing final directory separator if present.
	// Known limitation: on Windows, drive-relative paths fail. ("bin2cue X:ab.cue")
	let cueDirectory = options.sCueFilename;
	let readp = cueDirectory.length;
	while (readp > 0 && cueDirectory[readp - 1] !== '/' && cueDirectory[readp - 1] !== '\\') {
		readp--;
	}
	cueDirectory = cueDirectory.substring(0, readp);

	while (!feof(fdCueFile))
	{
		if (!fgets(sLine, 256, fdCueFile))
		{
			if (feof(fdCueFile)) break;
			perror("bin2iso(fgets)");
			printf("Error reading cuefile\n");
			exit(1);
		}

		currenttrack = ParseCueLine(sLine, currentfile, currenttrack);
	}

	if (nTracks == 0)
	{
		printf("Error: No TRACKs in cuefile\n");
		exit(1);
	}

	fclose(fdCueFile);
}

// Returns false when no data found, true when there is.
function CheckGaps(tTrack* track)
{
	//if (track.idx0 == track.idx1) return false; // should never happen

	if (0 != fseek(track.fdSrcFile, track.startOfs, SEEK_SET))
	{
		perror("\nbin2iso(fseek)");
		exit(1);
	}

	uint8_t buf[track.sectorSize];
	uint32_t nonzerocount = 0;
	uint32_t pregapsectors = track.idx1 - track.idx0;
	while (pregapsectors-- != 0)
	{
		if (0 == fread(buf, track.sectorSize, 1, track.fdSrcFile))
		{
			perror("bin2iso(fread)");
			exit(1);
		}
		uint32_t* readp = (uint32_t*)buf;
		for (off_t k = SIZERAW >> 2; k > 0; k--)
		{
			if (*readp != 0)
				nonzerocount++;
			readp++;
		}
	}
	printf("%u non-zero sample pairs in pregap data: ", nonzerocount);
	if (nonzerocount > (SIZERAW >> 3))
	{
		printf("Save\n");
		return true;
	}

	printf("Discard\n");
	return false;
}

function IsoFromCue() {
	ParseCue();
  
	for (let i = 0; i < nTracks; i++) {
	  if (tracks[i].idx0 < 0) tracks[i].idx0 = 0;
	  if (tracks[i].idx1 < 0) tracks[i].idx1 = 0;
	  if (tracks[i].idx0 > tracks[i].idx1) {
		console.log('Error: Index0 > Index1 on track %d\n', tracks[i].num);
		return;
	  }
	}
	tracks[nTracks].idx0 = tracks[nTracks].idx1 = 0;
  
	if (options.noGaps) console.log('Note: Discarding any pregap data\n');
	else if (options.allPostGaps)
	  console.log('Note: Appending any pregap data to end of audio tracks\n');
	else console.log('Note: Saving any pregap data without changes\n');
  
	// Calculate pregaps and track lengths, from offset1 to next file's offset0, or to file end.
	// Since sector sizes may vary from track to track, have to calculate the byte offset for
	// each track in a file incrementally. This assumes each FILE is only declared once in the
	// cuefile, and TRACKs are in strictly ascending order.
	const trackofs = 0; // off_t trackofs = 0;
	for (i = 0; i < nTracks; i++) {
	  tracks[i].startOfs = trackofs;
  
	  const pregapframes = tracks[i].idx1 - tracks[i].idx0; // uint32_t
	  if (pregapframes != 0) {
		if (!options.noGaps && (!options.autoGaps || CheckGaps(tracks[i]))) {
		  console.log(
			'Note: track %d pregap = %d frames\n',
			tracks[i].num,
			pregapframes
		  );
  
		  if (options.allPostGaps) {
			// Change pregaps to postgaps on the previous track, if it's an audio track.
			if (
			  i != 0 &&
			  trackofs != 0 &&
			  (tracks[i - 1].mode == MODE_AUDIO ||
				tracks[i - 1].mode == MODE_AUDIOSUB)
			)
			  tracks[i - 1].totalSectors += pregapframes;
			trackofs += pregapframes * tracks[i].sectorSize;
			tracks[i].startOfs = trackofs;
		  } else {
			// Preserve pregap.
			tracks[i].idx1 = tracks[i].idx0;
		  }
		} else {
		  // Don't save pregap.
		  trackofs += pregapframes * tracks[i].sectorSize;
		  tracks[i].startOfs = trackofs;
		}
	  }
  
	  if (
		i + 1 == nTracks ||
		strcmp(tracks[i].sSrcFileName, tracks[i + 1].sSrcFileName) != 0
	  ) {
		// Final track, or next track is in a different file: track runs to end of file.
		const filesize = GetFileSize(tracks[i].fdSrcFile); // off_t
		const trackbytes = filesize - trackofs; // off_t
		if (trackbytes < 0) {
		  console.log('Error: Track %d Index1 past file end\n', tracks[i].num);
		  return;
		}
		if (trackbytes % tracks[i].sectorSize != 0)
		  console.log(
			'Warning: Track %d bytesize %lu not divisible by its sector size %u\n',
			tracks[i].num,
			trackbytes,
			tracks[i].sectorSize
		  );
  
		tracks[i].totalSectors = trackbytes / tracks[i].sectorSize;
		trackofs = 0;
	  } else {
		if (tracks[i].idx1 > tracks[i + 1].idx0) {
		  console.log(
			"Error: Track %d Index1 past next track's Index0\n",
			tracks[i].num
		  );
		  return;
		}
		tracks[i].totalSectors = tracks[i + 1].idx0 - tracks[i].idx1;
		trackofs += tracks[i].totalSectors * tracks[i].sectorSize;
	  }
  
	  if (tracks[i].totalSectors == 0)
		console.log('Warning: track %d is empty\n', tracks[i].num);
	}
  
	// If not allowing overburn, then create a new track to hold extra data...
	// This has not been well-tested.
	if (options.noOverburn) {
	  if (tracks[nTracks].idx0 > CD74_MAX_SECTORS) {
		i = nTracks++;
		tracks[i] = tracks[i - 1];
		strcpy(tracks[i].name, 'obdatatemp.bin');
		tracks[i].idx0 = CD74_MAX_SECTORS;
		tracks[i].idx1 = CD74_MAX_SECTORS;
		tracks[i].mode = tracks[i - 1].mode;
	  }
	}
  
	console.log('\n');
	for (i = 0; i <= nTracks - 1; i++) {
	  const tracksize = tracks[i].totalSectors * tracks[i].sectorSize; // uint32_t
	  console.log(
		'%s (%d Mb) - sectors %06ld:%06ld (offset %09ld:%09ld)\n',
		tracks[i].name,
		tracksize >> 20,
		tracks[i].idx1,
		tracks[i].idx1 + tracks[i].totalSectors - 1,
		tracks[i].startOfs,
		tracks[i].startOfs + tracksize - 1
	  );
	}
	console.log('\n');
  
	if (options.doInPlace && nTracks == 1 && tracks[0].mode == MODE1_2048) {
	  console.log('Single track bin file indicated by cue file\n');
	  if (0 != rename(tracks[0].sSrcFileName, tracks[0].name)) {
		console.error('\nbin2iso(rename)');
		return;
	  }
	  console.log('%s renamed to %s\n', tracks[0].sSrcFileName, tracks[0].name);
	  return;
	}
  
	for (i = nTracks - 1; i >= 0; i--) {
	  if (!options.doOneTrack || tracks[i].num == options.oneTrackNum)
		DoTrack(tracks[i]);
  
	  if (BONK == 1) {
		//#if (BONK == 1)
		const trackA = tracks[i]; // tTrack
		const trackB = tracks[i + 1]; // tTrack
  
		if (!options.doOneTrack && options.doInPlace) {
		  if (i != 0 || trackA.mode == MODE_AUDIO || trackA.mode == MODE2_2336) {
			console.log('Truncating bin file to %ld bytes\n', trackA.offset1);
			if (-1 == ftruncate(fileno(trackA.fdSrcFile), trackA.offset1)) {
			  console.error('\nbin2iso(_chsize)');
			  return;
			}
		  } else {
			console.log('Renaming %s to %s\n', trackA.sSrcFileName, trackA.name);
			fclose(trackA.fdSrcFile);
			if (0 != rename(trackA.sSrcFileName, trackA.name)) {
			  console.error('\nbin2iso(rename)');
			  return;
			}
  
			// fix writepos for case when simply truncating...
			if (trackA.mode == MODE2_2352 || trackA.mode == MODE1_2048)
			  writePos = trackB.offset0;
  
			console.log('Truncating to %ld bytes\n', writePos);
  
			trackA.fdSrcFile = fopen(trackA.name, 'rb+'); // gets closed in DoTrack...
			if (trackA.fdSrcFile == NULL) {
			  console.error('bin2iso(fopen)');
			  return;
			}
  
			if (-1 == ftruncate(fileno(trackA.fdSrcFile), writePos)) {
			  console.error('\nbin2iso(_chsize)');
			  return;
			}
		  }
		}
	  }
	}
  }
  

/* /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/ */

void CheckIsoHeader(uint8_t* buffer, uint32_t* sectorcount)
{
	if (memcmp(buffer, isoVolumeDescriptor, 8) == 0)
	{
		tIsoDescriptor* header = (tIsoDescriptor*)buffer;
		printf("(System ID: %.32s)\n(Volume ID: %.32s)\n", header.systemId, header.volumeId);
		printf("(ISO track size: %d blocks * %d bytes)\n",
			header.volumeBlockCountLSB, header.logicalBlockSizeLSB);
		if (header.logicalBlockSizeLSB != 2048)
			printf("Warning: Unexpected block size, probably wrong\n");

		*sectorcount = header.volumeBlockCountLSB;
	}
}

function AnalyseTrack(srcfile, modetxt, subchanbytes)
{
	strcpy(modetxt, "AUDIO");
	let isotrackbytes = 0;
	let isotracksectors = 0;
	let sectorsize = SIZERAW;

	// To identify what kind of track is starting from the current sector, read and evaluate the
	// first 50k bytes of the track.
	uint8_t buffer[50000];
	off_t readpos = ftell(srcfile);
	if (1 != fread(buffer, 50000, 1, srcfile))
	{
		perror("bin2iso(fread)");
		exit(1);
	}
	off_t filesize = GetFileSize(srcfile);

	if (memcmp(buffer, syncPattern, 12) == 0)
	{
		// The track starts with a sync pattern. Double-check if the same pattern repeats after
		// various possible sector sizes, and the second one's time index is greater than the
		// first one's.
		uint32_t timeindexA = (buffer[12] << 16) | (buffer[13] << 8) | buffer[14];

		bool found = false;
		for (sectorsize = 2064; sectorsize < 2560; sectorsize += 4)
		{
			if (memcmp(buffer + sectorsize, syncPattern, 12) != 0)
				continue;

			uint32_t timeindexB =
				(buffer[sectorsize + 12] << 16)
				| (buffer[sectorsize + 13] << 8)
				| buffer[sectorsize + 14];
			if (timeindexB <= timeindexA || buffer[15] != buffer[sectorsize + 15])
				continue;

			printf("(Track has sync pattern, indicates mode %d)\n", buffer[15]);
			sprintf(modetxt, "MODE%d/%d", buffer[15], sectorsize);

			// If there's an ISO volume descriptor, we can know more about this track.
			// It's from sector 16 onward (0x8000 in raw user data).
			uint32_t hdrofs = sectorsize * 16;
			hdrofs += (buffer[15] == 1) ? 16 : 24; // skip sector preamble to user data
			CheckIsoHeader(buffer + hdrofs, &isotracksectors);
			if (isotracksectors != 0)
				isotrackbytes = isotracksectors * sectorsize;
			else
				printf("(ISO descriptor was not found)\n");

			// The image should go straight into audio tracks after the end of ISO data, but there
			// may be several empty sectors with just the sync pattern.
			while (true)
			{
				if (0 != fseek(srcfile, readpos + isotrackbytes, SEEK_SET))
				{
					perror("\nbin2iso(fseek)");
					exit(1);
				}
				if (1 != fread(buffer, 12, 1, srcfile))
				{
					if (feof(srcfile)) break;
					perror("bin2iso(fread)");
					exit(1);
				}
				if (memcmp(buffer, syncPattern, 12) != 0) break;
				isotrackbytes += sectorsize;
				isotracksectors++;
			}

			// Check that the remaining filesize is divisible by 2352. If not, the audio tracks
			// may have subchannel data embedded.
			uint32_t remaining = filesize - readpos - isotrackbytes;
			if (remaining % SIZERAW != 0 && remaining % sectorsize != 0)
			{
				printf("Warning: Remaining image size %d is not divisible by %d or %d\n",
					remaining, SIZERAW, sectorsize);
			}
			else
			{
				if (sectorsize < SIZERAW)
					printf("Warning: Remaining image size %d uses unexpected sector size %d\n",
						remaining, sectorsize);
				else if (sectorsize > SIZERAW)
				{
					*subchanbytes = sectorsize - SIZERAW;
					printf("(Audio sectors embed %d bytes of subchannel data)\n", *subchanbytes);
				}
			}

			found = true;
			break;
		}

		if (!found)
		{
			console.log("(Found sync pattern but failed to recognise sector size; can't convert correctly)\n");
		}
	}
	else
	{
		// No sync pattern detected. Probably raw 2048-byte user data, or audio track.
		CheckIsoHeader(buffer + 0x8000, &isotracksectors);
		if (isotracksectors != 0)
		{
			printf("(Track has an ISO descriptor, indicates raw user data)\n");
			strcpy(modetxt, "MODE1/2048");
			sectorsize = 2048;
		}
		else
		{
			// If the ISO volume descriptor is found at 0x9208, it's MODE2/2336.
			CheckIsoHeader(buffer + 0x9208, &isotracksectors);
			if (isotracksectors != 0)
			{
				printf("(Track has an ISO descriptor, indicates mode2/2336)\n");
				strcpy(modetxt, "MODE2/2336");
				sectorsize = 2336;
			}
			// If there's a UDF descriptor, it's a UDF filesystem, raw user data.
			else if (memcmp(buffer + 0x8000, &udfVolumeDescriptor, 8) == 0)
			{
				printf("(Track has a UDF ISO descriptor)\n");
				strcpy(modetxt, "MODE1/2048");
				sectorsize = 2048;
				isotracksectors = filesize / 2048;
			}
			else
			{
				printf("(No sync pattern or ISO descriptor recognised, probably audio track)\n");
			}
		}

		// There may be extra 2k-size sectors after the official end of ISO data, but they're
		// likely all zeroed out. Ensure the rest of the file can be read in 2352-byte blocks and
		// there are no bytes left over.
		if (isotracksectors != 0)
		{
			// Both 2048 and 2336 need to repeat at most 147 times to be 2352-aligned.
			const maxcount = 147;

			isotrackbytes = isotracksectors * sectorsize;
			let remaining = filesize - readpos - isotrackbytes;
			let count = 0;
			while (count <= maxcount && remaining > 0 && remaining % SIZERAW != 0)
			{
				remaining -= sectorsize;
				count++;
			}
			if (count <= maxcount)
			{
				isotrackbytes += count * sectorsize;
				isotracksectors += count;
			}
			else
				printf("Warning: Failed to align ISO track end, may still be ok\n");
		}
	}

	if (0 != fseek(srcfile, readpos + isotrackbytes, SEEK_SET))
	{
		perror("\nbin2iso(fseek)");
		exit(1);
	}

	return isotracksectors;
}

void CueFromBin()
{
	FILE* fdBinFile = fopen(options.sBinFilename, "rb");
	if (fdBinFile == NULL)
	{
		printf("Unable to open %s\n", options.sBinFilename);
		exit(1);
	}
	FILE* fdCueFile = fopen(options.sCueFilename, "w");
	if (fdCueFile == NULL)
	{
		printf("Unable to create %s\n", options.sCueFilename);
		exit(1);
	}

	int l = strlen(options.sBinFilename) - 4;
	if ((strcmp(&options.sBinFilename[l], ".wav") == 0)
		|| (strcmp(&options.sBinFilename[l], ".WAV") == 0))
	{
		printf(".wav binfile - Skipping wav header\n");
		fseek(fdBinFile, sizeof(tWavHead), SEEK_CUR);
	}
	else if ((strcmp(&options.sBinFilename[l], ".cdi") == 0)
		|| (strcmp(&options.sBinFilename[l], ".CDI") == 0))
	{
		printf("Warning: CDI discjuggler images are not raw\n");
		printf("Alternative tools cdi2iso or iat will work better for this.\n");
	}

	printf(            "FILE \"%s\" BINARY\n", options.sBinFilename);
	fprintf(fdCueFile, "FILE \"%s\" BINARY\n", options.sBinFilename);

	let modetxt;
	let indextxt;
	uint8_t* buffer; // this is a pointer to somewhere in inBuf, for zero-copy reads

	let track = 0;
	let subchanbytes = 0; // some exotic images include subchannel bytes on audio tracks
	let sector = AnalyseTrack(fdBinFile, modetxt, &subchanbytes);
	if (sector != 0)
	{
		printf(            "  TRACK 01 %s\n", modetxt);
		fprintf(fdCueFile, "  TRACK 01 %s\n", modetxt);
		printf(            "    INDEX 01 00:00:00\n");
		fprintf(fdCueFile, "    INDEX 01 00:00:00\n");
		track++;
	}
	strcpy(modetxt, "AUDIO"); // assume everything after the first track is raw audio
	let sectorsize = SIZERAW + subchanbytes; // assumes subchan data is at sector end
	if (subchanbytes != 0)
		sprintf(modetxt, "AUDIO/%d", sectorsize); // non-standard but consistent

	// To split the audio stream into tracks, need to find the quietest or completely silent
	// troughs between songs. Take a Root Mean Square from every audio sector. If the RMS is below
	// a user-definable threshold, the sector may be a track gap. If several such sectors in a row
	// (also user-definable number) are below the RMS threshold, generate a track split.
	//
	// When generating a split, must identify as precisely as possible when the previous song has
	// really faded out entirely. That point is in the sector with the lowest RMS within the
	// entire gap. If multiple sectors have the same lowest value (likely 0), the earliest gets to
	// be the next track's Index 0 (pregap start), and the latest gets to be Index 1 (song start).
	//
	// Fades in and out can be tricky, since they have periods on both sides of the RMS limit for
	// a significant number of sectors, producing false splits. A minimum track length requirement
	// of several seconds may help against that for fade-ins. (Not implemented here.)
	//
	// Pops/clicks between tracks can generate a false split. To avoid this, require a minimum
	// number of individual samples exceeding the RMS limit value within the sector.

	//const uint32_t minTrackSecs = 8;
	const minSampleHits = 120;
	let gapsectors = 0;
	let lowestRMS, lowestRMSsector0, lowestRMSsector1;
	let limitsquared = options.splitRmsLimit * options.splitRmsLimit;

	while (BufferedFRead(&buffer, sectorsize, fdBinFile))
	{
		// Calculating RMS over 2352 samples requires a uint64 or the accumulator can overflow.
		let RMS = 0;
		let samplehits = 0;

		for (let i = 0; i < SIZERAW; i += 2)
		{
			let value = buffer[i] | (buffer[i + 1] << 8);
			let squared = value * value;
			RMS += squared;
			if (squared > limitsquared)
				samplehits++;
		}
		RMS = RMS / SIZERAW;

		if (RMS > limitsquared && samplehits > minSampleHits)
		{
			if (gapsectors == 0)
			{
				// This sector is above RMS limit, and not in a potential gap: do nothing.
			}
			else
			{
				// This sector is above RMS limit, and in a potential gap: generate split.
				if (gapsectors >= options.splitGapLength)
				{
					track++;
					printf(            "  TRACK %02d %s\n", track, modetxt);
					fprintf(fdCueFile, "  TRACK %02d %s\n", track, modetxt);

					TimeIndex(lowestRMSsector0, indextxt);
					printf(            "    INDEX 00 %s\n", indextxt);
					fprintf(fdCueFile, "    INDEX 00 %s\n", indextxt);

					TimeIndex(lowestRMSsector1, indextxt);
					printf(            "    INDEX 01 %s\n", indextxt);
					fprintf(fdCueFile, "    INDEX 01 %s\n", indextxt);
				}
				gapsectors = 0;
			}
		}
		else
		{
			if (gapsectors != 0)
			{
				// This sector is below RMS limit, and in a potential gap: track gap.
				if (RMS <= lowestRMS)
				{
					if (RMS != lowestRMS)
					{
						lowestRMS = RMS;
						lowestRMSsector0 = sector;
					}
					lowestRMSsector1 = sector;
				}
			}
			else
			{
				// This sector is below RMS limit, and not in a potential gap: new potential gap.
				lowestRMS = RMS;
				lowestRMSsector0 = sector;
				lowestRMSsector1 = sector;
			}
			gapsectors++;
		}

		sector++;
	}
	fclose(fdCueFile);
	fclose(fdBinFile);
}

/* /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/ */

void PrintHelp()
{
	printf(`\nbin2iso "${VERSIONSTR}" - Converts raw BIN/IMG/MDF image files to ISO + WAV files`);
	printf("\nOriginal by Bob Doiron, this version by Kirinn Bunnylin");
	printf("\nhttps://gitlab.com/bunnylin/bin2iso\n\n");

	printf("Run this with a CUE file, not the raw image file.\n");
	printf("To use CCD/MDS files, convert to CUE first (ccd2cue, mdf2iso).\n");
	printf("Usage: bin2iso <cuefile> [<output dir>] [-napib] [-t X]\n\n");

	printf("  <cuefile>     The .CUE file for the image file being converted.\n");
	printf("  <output dir>  The output directory (defaults to current dir).\n");
	printf("  -n --nogaps   Discard any data in 'gaps' between tracks.\n");
	printf("  -a --gaps     Save 'gaps' only if they contain notable non-zero data.\n");
	printf("                Looks for more than 1/2 block of non-zeroes (%d values).\n", SIZERAW / 2 / 2);
	printf("                Without -n or -a, by default all gap data is saved.\n");
	printf("  -p --pregaps  Don't convert pregaps to postgaps, save as is.\n");
	printf("  -t --track=X  Extracts only the X'th track.\n");
	printf("  -i --inplace  Performs the conversion 'in place'; ie. truncates the binfile\n");
	printf("                after each track is created to minimize space usage.\n");
	printf("                (can't be used with -t)\n");
	printf("  -b --nob      Do not use overburn data past %d sectors.\n", CD74_MAX_SECTORS);
	printf("                This of course presumes that the data is not useful.\n\n");

	printf("Use the -c switch to auto-generate a CUE file from any raw image.\n");
	printf("Usage: bin2iso <cuefile> -c <binfile> [-l X] [-w X]\n\n");

	printf("  -c --cuefrom=<binfile>\n");
	printf("                Attempts to create a <cuefile> from an existing <binfile>.\n");
	printf("  -l --level=X  When creating a cuefile, split audio tracks when many sectors\n");
	printf("                in a row are below this volume (RMS) level. Default: %d\n", options.splitRmsLimit);
	printf("  -w --width=X  When creating a cuefile, split audio tracks when this many\n");
	printf("                sectors are below the RMS limit. 75 = 1 second. Default: %d\n\n", options.splitGapLength);

	printf("If the cuefile missed some track splits, try a higher level or lower width.\n");
	printf("If it generated too many splits, try a lower level or higher width.\n");
}

function ParseArgs(int argc, char* argv[])
{
	const short_opts = "napt:ibc:l:w:vh?";
	// long_opts = [
	// 	{ "nogaps", no_argument, NULL, 'n' },
	// 	{ "gaps", no_argument, NULL, 'a' },
	// 	{ "pregaps", no_argument, NULL, 'p' },
	// 	{ "track", required_argument, NULL, 't' },
	// 	{ "inplace", no_argument, NULL, 'i' },
	// 	{ "nob", no_argument, NULL, 'b' },
	// 	{ "cuefrom", required_argument, NULL, 'c' },
	// 	{ "level", required_argument, NULL, 'l' },
	// 	{ "width", required_argument, NULL, 'w' },
	// 	{ "version", no_argument, NULL, 'v' },
	// 	{ "help", no_argument, NULL, 'h' },
	// 	{ NULL, no_argument, NULL, 0 }
	// ];
	optind;

	options.allPostGaps = true; // convert all pregaps to postgaps by default
	options.splitRmsLimit = 80;
	options.splitGapLength = 48; // 0.64 seconds
	strcpy(options.outputDir, "./"); // default path

	while (true)
	{
		const opt = getopt_long(argc, argv, short_opts, long_opts, NULL);
		if (opt == -1)
			break;

		if (optarg)
			if (optarg[0] == '=' || optarg[0] == ':')
				optarg++;

		switch (opt)
		{
			case 'n':
				options.noGaps = true;
				break;

			case 'a':
				options.autoGaps = true;
				break;

			case 'p':
				options.allPostGaps = false;
				break;

			case 't':
			{
				if (options.doInPlace)
				{
					printf("Can't use -t and -i together.\n");
					return false;
				}
				options.oneTrackNum = strtol(optarg, NULL, 10);
				options.doOneTrack = true;
				break;
			}

			case 'i':
				if (options.doOneTrack)
				{
					printf("Can't use -t and -i together.\n");
					return false;
				}
				printf("Bin file will be truncated after each track created\n");
				options.doInPlace = true;
				break;

			case 'b':
				options.noOverburn = true;
				break;

			case 'c':
				options.createCue = true;
				strcpy(options.sBinFilename, optarg);
				break;

			case 'l':
				options.splitRmsLimit = (uint16_t)strtol(optarg, NULL, 10);
				break;

			case 'w':
				options.splitGapLength = (uint16_t)strtol(optarg, NULL, 10);
				break;

			case 'v':
				printf(VERSIONSTR+"\n");
				exit(0);
				break;

			case '?':
			case 'h':
			default:
				return false;
		}
	}

	if (optind == argc)
	{
		printf("<cuefile> must be specified.\n");
		return false;
	}

	strcpy(options.sCueFilename, argv[optind++]);
	if (optind < argc)
	{
		strcpy(options.outputDir, argv[optind++]);
		let i = strlen(options.outputDir);
		if (i > 0)
		{
			if ((options.outputDir[i - 1] != '/') && (options.outputDir[i - 1] != ':'))
			{
				strcat(options.outputDir, "/");
			}
		}
	}
	if (optind < argc)
	{
		printf("Unexpected argument: %s\n", argv[optind]);
		return false;
	}

	return true;
}

function main(argc, argv)
{
	if (!ParseArgs(argc, argv))
	{
		PrintHelp();
		return 1;
	}

	if (options.createCue)
		CueFromBin();
	else
		IsoFromCue();

	return 0;
}
