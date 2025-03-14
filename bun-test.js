import { cc } from 'bun:ffi';

export const {
  symbols: { myRandom },
} = cc({
  source: './bin2iso.c',
  symbols: {
    main: {
      returns: 'int',
      args: [],
    },
  },
});

console.log('main() =', main());
