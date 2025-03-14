const VERSIONSTR = 'V2.0';

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
}

const HEADBYTES = 36;
const WINDOWS_PCM = 0x0001;

//-------------------------------------------------/

const MAXIMUM_TRACK_NUMBERS = 100;

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
}

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
let fdOutFile;
let cueDirectory = '';

// FROM bunnylin:
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
}

const tracks = new Array(MAXIMUM_TRACK_NUMBERS)
  .fill(null)
  .map(() => new Track());
let nTracks = 0;

/**
 * ! This function doesn't exist in bin2iso.c
 * I want this to be able to used on node or just the browser
 * @param {*} filename
 * @returns
 */
function openCueFile(filename) {
  if (typeof window !== 'undefined') {
    console.log('Running in browser – use a file input instead.');
  } else {
    const fs = require('fs');
    try {
      fs.accessSync(filename, fs.constants.R_OK);
      console.log(`File "${filename}" is accessible.`);
      return true;
    } catch (err) {
      console.error(`Error: Unable to open "${filename}"`, err);
      process.exit(1);
    }
  }
}

// tTrack* ParseCueLine(char* readp, char* activefile, tTrack* track)
function ParseCueLine(readp, activefile, track) {
  // For reference:
  // https://www.gnu.org/software/ccd2cue/manual/html_node/CUE-sheet-format.html#CUE-sheet-format
  // https://kodi.wiki/view/Cue_sheets

  // Skip leading spaces. Usually there's an exact amount of whitespace for each command, but
  // some CUE file generators produce fewer or more spaces. Should skip tab too?..
  while (readp == ' ' || readp == '\n' || readp == '\r') readp++;
  if (readp == '\0') return track; // empty line

  // FILE "<filename>" <MODE>
  // The filename might include an absolute or relative directory, but usually is just the file.
  // Filename is usually in quotes, but they can be omitted if it has no spaces.
  // Mode is usually BINARY, but could be WAVE, AIFF, MP3. Also MOTOROLA for big-endian binary.
  // We only want the filename, ignore the mode.
  if (strncmp(readp, 'FILE ', 5) == 0) {
    readp += 5;
    while (readp == ' ') readp++; // just in case

    const writep = activefile;
    const terminator = ' ';

    while (readp != '\0' && readp != terminator) {
      switch (readp) {
        // case 1 ... 31:
        case 1:
        case 2:
        case 3:
          // Ignore unexpected control characters silently.
          break;

        case '/':
        case '\\':
          // Just ignore anything to the left of every path separator.
          // Technically incorrect, but directory references in CUE files are invalid
          // more often than not...
          writep = activefile;
          break;

        case '"':
          terminator = '"';
          break;

        default:
          // *(writep++) = *readp;
          writep += readp; // Appends the character to writep
          break;
      }

      readp++;
    }

    if (terminator == '"' && readp != '"') {
      console.log(
        "Error: Unpaired \" in 'FILE' in cuefile %s\n",
        options.sCueFilename
      );
      return;
    }

    if (writep == activefile) {
      console.log(
        "Error: Empty name for 'FILE' in cuefile %s\n",
        options.sCueFilename
      );
      return;
    }
    writep = '\0';
    track = NULL;
  }

  // TRACK <number> <DATATYPE>
  // The index number should be in the 1..99 range, and unique within this CUE file.
  // The number doesn't have to have a leading 0. It should grow by +1 for each new track.
  // The track's source FILE context must have appeared already.
  // DATATYPE is AUDIO or one of several binary data descriptors.
  else if (strncmp(readp, 'TRACK ', 6) == 0) {
    readp += 6;
    while (readp == ' ') readp++;

    if (nTracks >= MAXIMUM_TRACK_NUMBERS) {
      console.log(
        'Error: Too many tracks in cuefile %s\n',
        options.sCueFilename
      );
      return;
    }

    track = tracks[nTracks++];
    track.idx0 = -1;
    track.idx1 = -1;
    track.sectorSize = SIZERAW;
    track.predata = 0;
    track.postdata = 0;

    if (activefile[0] == '\0') {
      console.log(
        'Error: TRACK before FILE in cuefile %s\n',
        options.sCueFilename
      );
      return;
    }
    strcpy(track.sSrcFileName, activefile);
    track.fdSrcFile = OpenCaseless(activefile);

    // Read the index number straight into track.num, use numstr to refer back to this index.
    const numstr = readp;
    track.num = 0;
    // TODO
    // while (*readp >= '0' && *readp <= '9')
    // 	track.num = track.num * 10 + (*(readp++) - '0');
    // *(readp++) = '\0'; // numstr terminator
    // while (*readp == ' ') readp++;
    while (readp >= '0' && readp <= '9')
      track.num = track.num * 10 + (readp++ - '0');
    readp = '\0';
    while (readp == ' ') readp++;

    // Regarding modes - https://en.wikipedia.org/wiki/CD-ROM
    // CD sectors always contains 2352 bytes. Depending on mode, part of that space is used
    // for error check values or other metadata. But when calculating the data start offset
    // for any track, the sector index is always multiplied by 2352.
    // However, a disk image may be saved with an unusual sector size, omitting part of the
    // physical 2352 bytes, or including subchannel data to go above 2352 bytes.
    if (strncmp(readp, 'AUDIO/', 6) == 0) track.mode = MODE_AUDIOSUB;
    else if (strncmp(readp, 'AUDIO', 5) == 0) track.mode = MODE_AUDIO;
    else if (strncmp(readp, 'MODE1/2352', 10) == 0) track.mode = MODE1_2352;
    else if (strncmp(readp, 'MODE1/2048', 10) == 0) track.mode = MODE1_2048;
    else if (strncmp(readp, 'MODE1/2448', 10) == 0) track.mode = MODE1_2448;
    else if (strncmp(readp, 'MODE2/2352', 10) == 0) track.mode = MODE2_2352;
    else if (strncmp(readp, 'MODE2/2336', 10) == 0) track.mode = MODE2_2336;
    else if (strncmp(readp, 'MODE2/2448', 10) == 0) track.mode = MODE2_2448;
    else {
      console.log('Error: Track %s - Unknown mode: [%s]\n', numstr, readp);
      return;
    }

    switch (track.mode) {
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
    strcpy(track.name, track.sSrcFileName);
    const extp = strrchr(track.name, '.'); // char*
    if (extp != NULL) extp = '\0';
    strcat(track.name, '-');
    strcat(track.name, numstr);

    if (track.mode == MODE_AUDIO || track.mode == MODE_AUDIOSUB)
      strcat(track.name, '.wav');
    else strcat(track.name, '.iso');
  }

  // INDEX <number> <mm:ss:ff>
  // The index number is 0 for pre-gap start, 1 for actual data start. What if 2 or greater?
  // The number doesn't have to have a leading 0.
  // The index's source TRACK context must have appeared already.
  // The time value is a time-encoded offset relative to the start of the FILE, which converts
  // to a sector index.
  else if (strncmp(readp, 'INDEX ', 6) == 0) {
    readp += 6;
    while (readp == ' ') readp++;

    if (track == NULL) {
      console.log(
        'Error: INDEX without active TRACK cuefile %s\n',
        options.sCueFilename
      );
      return;
    }

    const numstr = readp; // char*
    const i = 0; // int32_t
    // TODO
    // while (*readp >= '0' && *readp <= '9')
    // 	i = i * 10 + (*(readp++) - '0');
    while (readp >= '0' && readp <= '9') i = i * 10 + (readp++ - '0');

    if (i >= 2) {
      readp = '\0';
      console.log('Error: Unexpected INDEX number: %s\n', numstr);
      // Maybe should just warn, return, and keep going?
      return;
    }

    while (readp == ' ') readp++;

    const min = ((readp[0] - '0') << 4) | (readp[1] - '0'); // char
    const sec = ((readp[3] - '0') << 4) | (readp[4] - '0'); // char
    const frame = ((readp[6] - '0') << 4) | (readp[7] - '0'); // char

    if (i == 0) {
      if (track.mode != MODE_AUDIO && track.mode != MODE_AUDIOSUB) {
        console.log(
          'Error: Index 0 pregap defined on non-audio track %d\n',
          track.num
        );
        return;
      }
      track.idx0 = SectorIndex(min, sec, frame);
      if (track.idx1 == -1) track.idx1 = track.idx0;
    } else {
      track.idx1 = SectorIndex(min, sec, frame);
      if (track.idx0 == -1) track.idx0 = track.idx1;
    }
  }

  // The pre- and postgap commands supposedly are there to request an artificial gap be added,
  // which is not actually in the source data. Let's ignore those...
  else if (strncmp(readp, 'PREGAP ', 7) == 0) {
  } else if (strncmp(readp, 'POSTGAP ', 8) == 0) {
  }
  // Other functionally uninteresting commands, ignore.
  else if (strncmp(readp, 'CDTEXTFILE ', 11) == 0) {
  } else if (strncmp(readp, 'SONGWRITER ', 11) == 0) {
  } else if (strncmp(readp, 'PERFORMER ', 10) == 0) {
  } else if (strncmp(readp, 'CATALOG ', 8) == 0) {
  } else if (strncmp(readp, 'FLAGS ', 6) == 0) {
  } else if (strncmp(readp, 'TITLE ', 6) == 0) {
  } else if (strncmp(readp, 'ISRC ', 5) == 0) {
  } else if (strncmp(readp, 'REM ', 4) == 0) {
  } else {
    console.log('Unrecognised line in CUE: "%s"\n', readp);
  }

  return track;
}

function ParseCue() {
  // FILE* fdCueFile = fopen(options.sCueFilename, "r");
  const fdCueFile = openCueFile(options.sCueFilename);
  if (fdCueFile == null) {
    perror('bin2iso(fopen)');
    console.log('Error: Unable to open "%s"\n', options.sCueFilename);
    return;
  }

  const sLine = ''; //char sLine[256];
  const currentFile = ''; //char currentfile[256] = "";
  const currenttrack = null; // tTrack*

  // Extract directory from cue path, removing final directory separator if present.
  // Known limitation: on Windows, drive-relative paths fail. ("bin2cue X:ab.cue")
  // TODO
  // strcpy(cueDirectory, options.sCueFilename);
  // const readp = cueDirectory + strlen(cueDirectory);
  // while (readp != cueDirectory && *readp != '/' && *readp != '\\') readp--;
  // *readp = '\0';

  /* Read Cue File */
  // Start processing the lines, similar to the C loop
  // TODO
  let index = 0,
    totalLines = 0;
  while (index < totalLines) {
    let sLine = lines[index].trim(); // Similar to fgets and trimming extra spaces

    if (sLine === '') {
      index++;
      continue; // Skip empty lines (similar to your C logic where it ignores empty lines)
    }

    // Simulate the same logic as your C code
    currentTrack = parseCueLine(sLine, currentFile, currentTrack);

    index++;
  }
  // while (!feof(fdCueFile)) {
  //   if (!fgets(sLine, 256, fdCueFile)) {
  //     if (feof(fdCueFile)) break;
  //     perror('bin2iso(fgets)');
  //     console.log('Error reading cuefile\n');
  //     return;
  //   }

  //   currenttrack = ParseCueLine(sLine, currentfile, currenttrack);
  // }
  /* End Read Cue File */

  if (nTracks == 0) {
    console.log('Error: No TRACKs in cuefile\n');
    return;
  }

  fclose(fdCueFile);
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

function PrintHelp() {
  console.log(
    '\nbin2iso ' +
      VERSIONSTR +
      ' - Converts raw BIN/IMG/MDF image files to ISO + WAV files'
  );
  console.log('\nOriginal by Bob Doiron, this version by Kirinn Bunnylin');
  console.log('\nhttps://gitlab.com/bunnylin/bin2iso\n\n');

  console.log('Run this with a CUE file, not the raw image file.');
  console.log('To use CCD/MDS files, convert to CUE first (ccd2cue, mdf2iso).');
  console.log('Usage: bin2iso <cuefile> [<output dir>] [-napib] [-t X]\n\n');

  console.log(
    '  <cuefile>     The .CUE file for the image file being converted.'
  );
  console.log(
    '  <output dir>  The output directory (defaults to current dir).'
  );
  console.log("  -n --nogaps   Discard any data in 'gaps' between tracks.");
  console.log(
    "  -a --gaps     Save 'gaps' only if they contain notable non-zero data."
  );
  console.log(
    '                Looks for more than 1/2 block of non-zeroes (' +
      SIZERAW / 2 / 2 +
      ' values).'
  );
  console.log(
    '                Without -n or -a, by default all gap data is saved.'
  );
  console.log("  -p --pregaps  Don't convert pregaps to postgaps, save as is.");
  console.log("  -t --track=X  Extracts only the X'th track.");
  console.log(
    "  -i --inplace  Performs the conversion 'in place'; ie. truncates the binfile"
  );
  console.log(
    '                after each track is created to minimize space usage.'
  );
  console.log("                (can't be used with -t)");
  console.log(
    '  -b --nob      Do not use overburn data past ' +
      CD74_MAX_SECTORS +
      ' sectors.'
  );
  console.log(
    '                This of course presumes that the data is not useful.\n\n'
  );

  console.log(
    'Use the -c switch to auto-generate a CUE file from any raw image.'
  );
  console.log('Usage: bin2iso <cuefile> -c <binfile> [-l X] [-w X]\n\n');

  console.log('  -c --cuefrom=<binfile>');
  console.log(
    '                Attempts to create a <cuefile> from an existing <binfile>.'
  );
  console.log(
    '  -l --level=X  When creating a cuefile, split audio tracks when many sectors'
  );
  console.log(
    '                in a row are below this volume (RMS) level. Default: ' +
      options.splitRmsLimit
  );
  console.log(
    '  -w --width=X  When creating a cuefile, split audio tracks when this many'
  );
  console.log(
    '                sectors are below the RMS limit. 75 = 1 second. Default: ' +
      options.splitGapLength +
      '\n\n'
  );

  console.log(
    'If the cuefile missed some track splits, try a higher level or lower width.'
  );
  console.log(
    'If it generated too many splits, try a lower level or higher width.'
  );
}

const options = {
  allPostGaps: true,
  splitRmsLimit: 80,
  splitGapLength: 48,
  outputDir: './',
  noGaps: false,
  autoGaps: false,
  doInPlace: false,
  doOneTrack: false,
  oneTrackNum: null,
  noOverburn: false,
  createCue: false,
  sBinFilename: '',
  sCueFilename: '',
};

function parseArgs(argc, argv) {
  const shortOpts = 'napt:ibc:l:w:vh?';
  const longOpts = [
    { name: 'nogaps', hasArg: false, val: 'n' },
    { name: 'gaps', hasArg: false, val: 'a' },
    { name: 'pregaps', hasArg: false, val: 'p' },
    { name: 'track', hasArg: true, val: 't' },
    { name: 'inplace', hasArg: false, val: 'i' },
    { name: 'nob', hasArg: false, val: 'b' },
    { name: 'cuefrom', hasArg: true, val: 'c' },
    { name: 'level', hasArg: true, val: 'l' },
    { name: 'width', hasArg: true, val: 'w' },
    { name: 'version', hasArg: false, val: 'v' },
    { name: 'help', hasArg: false, val: 'h' },
  ];

  // TODO Making this a global?
  //   const options = {
  //     allPostGaps: true,
  //     splitRmsLimit: 80,
  //     splitGapLength: 48,
  //     outputDir: './',
  //     noGaps: false,
  //     autoGaps: false,
  //     doInPlace: false,
  //     doOneTrack: false,
  //     oneTrackNum: null,
  //     noOverburn: false,
  //     createCue: false,
  //     sBinFilename: '',
  //     sCueFilename: '',
  //   };

  let optind = 0;

  while (true) {
    const { opt, optarg } = getOptLong(argc, argv, shortOpts, longOpts, optind);
    if (opt === -1) break;

    if (optarg && (optarg[0] === '=' || optarg[0] === ':')) {
      optarg = optarg.substring(1);
    }

    switch (opt) {
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
        if (options.doInPlace) {
          console.log("Can't use -t and -i together.");
          return false;
        }
        options.oneTrackNum = parseInt(optarg, 10);
        options.doOneTrack = true;
        break;

      case 'i':
        if (options.doOneTrack) {
          console.log("Can't use -t and -i together.");
          return false;
        }
        console.log('Bin file will be truncated after each track created');
        options.doInPlace = true;
        break;

      case 'b':
        options.noOverburn = true;
        break;

      case 'c':
        options.createCue = true;
        options.sBinFilename = optarg;
        break;

      case 'l':
        options.splitRmsLimit = parseInt(optarg, 10);
        break;

      case 'w':
        options.splitGapLength = parseInt(optarg, 10);
        break;

      case 'v':
        console.log(VERSIONSTR);
        process.return;
        break;

      case '?':
      case 'h':
      default:
        return false;
    }
  }

  if (optind === argc || argc === undefined) {
    console.log('<cuefile> must be specified.');
    return false;
  }
  options.sCueFilename = argv[optind++];
  if (optind < argc) {
    options.outputDir = argv[optind++];
    const i = options.outputDir.length;
    if (i > 0) {
      if (
        options.outputDir[i - 1] !== '/' &&
        options.outputDir[i - 1] !== ':'
      ) {
        options.outputDir += '/';
      }
    }
  }
  if (optind < argc) {
    console.log(`Unexpected argument: ${argv[optind]}`);
    return false;
  }

  return true;
}

// Mock function for getOptLong to simulate option parsing
function getOptLong(argc, argv, shortOpts, longOpts, optind) {
  // This function should implement the logic to parse command line arguments
  // and return the appropriate option and argument. This is a placeholder.
  return { opt: -1, optarg: null }; // Replace with actual parsing logic
}

function main(argc, argv) {
  if (!parseArgs(argc, argv)) {
    PrintHelp();
    return 1;
  }

  if (options.createCue) {
    CueFromBin();
  } else {
    IsoFromCue();
  }

  return 0;
}

main(1, ['C:\\Users\\Jah.DESKTOP-JK06E9D\\Downloads\\Coffee-Tycoon_Win_EN_CD']);
