// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/// @notice Decodes the start of a brotli stream (RFC 7932) and stops once it has enough output.
/// @dev Port of packages/shared/src/brotli.ts (keep them in step). Prefix codes are decoded
///      canonically, one bit at a time; a code's symbol table is built when it's first used, since
///      most trees of a meta-block aren't needed for the first bytes. The static dictionary is not
///      supported: a reference to it reverts BrotliUnsupported, so a stream is refused, never misread.
///      Constants are from https://github.com/google/brotli.
library BrotliPrefix {
    /// @dev Not a valid brotli stream (or not enough input for the requested output).
    error BrotliInvalid(uint256 reason);
    /// @dev Valid brotli this decoder doesn't handle (static dictionary, large window).
    error BrotliUnsupported();

    uint256 private constant TRUNCATED = 1;
    uint256 private constant PADDING = 2;
    uint256 private constant RESERVED = 3;
    uint256 private constant LENGTH = 4;
    uint256 private constant SIMPLE_CODE = 5;
    uint256 private constant CODE_LENGTH_CODE = 6;
    uint256 private constant CODE_LENGTHS = 7;
    uint256 private constant PREFIX_CODE = 8;
    uint256 private constant CONTEXT_MAP = 9;
    uint256 private constant INSERT = 10;
    uint256 private constant COPY = 11;
    uint256 private constant DISTANCE = 12;

    // complex code length code order: 1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15 (byte i)
    uint256 private constant CODE_LENGTH_ORDER = 0xf0e0d0c0b0a090807100611050004030201;
    // per 64-symbol command range: insert code base | copy code base >> 3 (byte i)
    uint256 private constant CELL_POS = 0x12110a1002090801000100;
    // extra bits (byte i) and bases (16 bits each, two words: i < 16, i >= 16)
    uint256 private constant INSERT_EXTRA = 0x180e0c0a0908070605050404030302020101000000000000;
    uint256 private constant INSERT_BASE_0 = 0x62004200320022001a0012000e000a00080006000500040003000200010000;
    uint256 private constant INSERT_BASE_1 = 0x58421842084204420242014200c20082;
    uint256 private constant COPY_EXTRA = 0x180a09080706050504040303020201010000000000000000;
    uint256 private constant COPY_BASE_0 = 0x360026001e00160012000e000c000a00090008000700060005000400030002;
    uint256 private constant COPY_BASE_1 = 0x84604460246014600c6008600660046;
    uint256 private constant BLOCK_EXTRA = 0x180d0c0b0a090807060605050505040404040303030302020202;
    uint256 private constant BLOCK_BASE_0 = 0xd100b10091007100610051004100310029002100190011000d000900050001;
    uint256 private constant BLOCK_BASE_1 = 0x000040f120f110f108f104f102f101f10171013100f1;

    // context.c lookup tables: UTF8 p1, UTF8 p2, signed p1, signed p2 (256 bytes each)
    bytes private constant CONTEXT_LUT =
        hex"0000000000000000000404000004000000000000000000000000000000000000080c100c0c140c10181c0c0c200c240c2c2c2c2c2c2c2c2c2c2c202018281c0c0c3034343430343434303434343434303434343434303434343434180c1c0c0c0c383c3c3c383c3c3c383c3c3c3c3c383c3c3c3c3c383c3c3c3c3c180c1c0c000001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000102030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203000000000000000000000000000000000000000000000000000000000000000000010101010101010101010101010101020202020202020202020101010101010102020202020202020202020202020202020202020202020202020101010101010303030303030303030303030303030303030303030303030303010101010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002020202020202020202020202020202020202020202020202020202020202020008080808080808080808080808080810101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101018181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828283030303030303030303030303030303800010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040405050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050506060606060606060606060606060607";

    struct Reader {
        bytes data;
        uint256 pos; // bit position
        uint256 end; // data.length * 8
    }

    /// @dev A prefix code: `single` (symbol + 1) for a 0-bit code, else code lengths per symbol and
    ///      `counts` (symbols per length, 16 x 16 bits). `symbols` (2 bytes each, canonical order) is
    ///      built on first use.
    struct Code {
        uint256 single;
        bytes lengths;
        uint256 counts;
        uint256 total;
        bytes symbols;
    }

    struct State {
        Reader r;
        bytes out;
        uint256 len; // bytes out so far
        uint256 need;
        uint256 maxBackward;
        uint256[4] dist; // last, second-to-last, ...
        bytes lut;
    }

    struct MetaBlock {
        uint256[3] nbl; // block types: literal, command, distance
        uint256[3] blockType;
        uint256[3] prevType;
        uint256[3] blockLen;
        Code[3] typeCodes;
        Code[3] lenCodes;
        uint256 npostfix;
        uint256 ndirect;
        bytes modes;
        bytes cmapL;
        bytes cmapD;
        Code[] literal;
        Code[] command;
        Code[] distance;
    }

    /// @notice The first `need` bytes of `data`'s decompressed output (fewer if the stream ends first).
    function decode(bytes memory data, uint256 need) internal pure returns (bytes memory out) {
        unchecked {
            State memory s;
            s.r = Reader(data, 0, data.length << 3);
            s.out = new bytes(need);
            s.need = need;
            s.dist = [uint256(4), 11, 15, 16];
            s.lut = CONTEXT_LUT;
            Reader memory r = s.r;
            // window bits
            uint256 wbits = 16;
            if (_bit(r) != 0) {
                uint256 n = _bits(r, 3);
                if (n != 0) {
                    wbits = 17 + n;
                } else {
                    uint256 m = _bits(r, 3);
                    if (m == 1) revert BrotliUnsupported(); // large window
                    wbits = m != 0 ? 8 + m : 17;
                }
            }
            s.maxBackward = (1 << wbits) - 16;
            while (s.len < need) {
                uint256 isLast = _bit(r);
                if (isLast != 0 && _bit(r) != 0) break; // last and empty
                uint256 nibbles = _bits(r, 2);
                if (nibbles == 3) {
                    // metadata: skipped
                    if (isLast != 0) revert BrotliUnsupported();
                    if (_bit(r) != 0) revert BrotliInvalid(RESERVED);
                    uint256 skipBytes = _bits(r, 2);
                    uint256 skip;
                    for (uint256 i; i < skipBytes; ++i) {
                        uint256 b = _bits(r, 8);
                        if (i + 1 == skipBytes && skipBytes > 1 && b == 0) revert BrotliInvalid(LENGTH);
                        skip |= b << (8 * i);
                    }
                    _align(r);
                    if (skipBytes != 0) r.pos += (skip + 1) << 3;
                    continue;
                }
                uint256 mlen;
                for (uint256 i; i < nibbles + 4; ++i) {
                    uint256 nib = _bits(r, 4);
                    if (i + 1 == nibbles + 4 && i >= 4 && nib == 0) revert BrotliInvalid(LENGTH);
                    mlen |= nib << (4 * i);
                }
                mlen += 1;
                if (isLast == 0 && _bit(r) != 0) {
                    // uncompressed
                    _align(r);
                    for (uint256 i; i < mlen && s.len < need; ++i) {
                        _push(s, _bits(r, 8));
                    }
                    continue;
                }
                _compressed(s, mlen);
                if (isLast != 0) break;
            }
            out = s.out;
            uint256 len = s.len;
            assembly ("memory-safe") {
                mstore(out, len)
            }
        }
    }

    function _compressed(State memory s, uint256 mlen) private pure {
        unchecked {
            Reader memory r = s.r;
            MetaBlock memory m;
            for (uint256 i; i < 3; ++i) {
                m.nbl[i] = _varLenUint8(r) + 1;
                m.prevType[i] = 1;
                if (m.nbl[i] >= 2) {
                    m.typeCodes[i] = _readCode(r, m.nbl[i] + 2);
                    m.lenCodes[i] = _readCode(r, 26);
                    m.blockLen[i] = _blockLength(r, m.lenCodes[i]);
                } else {
                    m.blockLen[i] = 1 << 30;
                }
            }
            m.npostfix = _bits(r, 2);
            m.ndirect = _bits(r, 4) << m.npostfix;
            m.modes = new bytes(m.nbl[0]);
            for (uint256 i; i < m.nbl[0]; ++i) {
                m.modes[i] = bytes1(uint8(_bits(r, 2)));
            }
            uint256 treesL = _varLenUint8(r) + 1;
            m.cmapL = _contextMap(r, m.nbl[0] << 6, treesL);
            uint256 treesD = _varLenUint8(r) + 1;
            m.cmapD = _contextMap(r, m.nbl[2] << 2, treesD);
            m.literal = _readCodes(r, treesL, 256);
            m.command = _readCodes(r, m.nbl[1], 704);
            m.distance = _readCodes(r, treesD, 16 + m.ndirect + (48 << m.npostfix));
            _commands(s, m, mlen);
        }
    }

    function _commands(State memory s, MetaBlock memory m, uint256 remaining) private pure {
        unchecked {
            Reader memory r = s.r;
            uint256 need = s.need;
            while (remaining > 0 && s.len < need) {
                if (m.blockLen[1] == 0) _switchBlock(r, m, 1);
                --m.blockLen[1];
                uint256 cmd = _decodeSymbol(r, m.command[m.blockType[1]]);
                uint256 cell = _byte(CELL_POS, cmd >> 6);
                uint256 insertCode = (cell & 0x18) + ((cmd >> 3) & 7);
                uint256 copyCode = ((cell << 3) & 0x18) + (cmd & 7);
                uint256 insertLen =
                    _word16(INSERT_BASE_0, INSERT_BASE_1, insertCode) + _bits(r, _byte(INSERT_EXTRA, insertCode));
                uint256 copyLen = _word16(COPY_BASE_0, COPY_BASE_1, copyCode) + _bits(r, _byte(COPY_EXTRA, copyCode));
                if (insertLen > remaining) revert BrotliInvalid(INSERT);
                for (uint256 i; i < insertLen; ++i) {
                    if (m.blockLen[0] == 0) _switchBlock(r, m, 0);
                    --m.blockLen[0];
                    uint256 t = m.blockType[0];
                    uint256 tree = uint8(m.cmapL[(t << 6) + _literalContext(s, uint8(m.modes[t]))]);
                    _push(s, _decodeSymbol(r, m.literal[tree]));
                    if (s.len >= need) return; // enough: the rest of the command isn't needed
                }
                remaining -= insertLen;
                if (remaining == 0) break; // the copy is ignored at the end of a meta-block
                uint256 distance;
                uint256 code;
                if (cmd >> 6 < 2) {
                    distance = s.dist[0]; // implicit distance code 0
                } else {
                    if (m.blockLen[2] == 0) _switchBlock(r, m, 2);
                    --m.blockLen[2];
                    uint256 ctx = copyLen > 4 ? 3 : copyLen - 2;
                    code = _decodeSymbol(r, m.distance[uint8(m.cmapD[(m.blockType[2] << 2) + ctx])]);
                    distance = _distance(s, code, m.npostfix, m.ndirect);
                }
                uint256 maxDistance = s.len < s.maxBackward ? s.len : s.maxBackward;
                if (distance > maxDistance) revert BrotliUnsupported(); // static dictionary reference
                if (code != 0) {
                    // every explicit distance but code 0 enters the ring
                    s.dist[3] = s.dist[2];
                    s.dist[2] = s.dist[1];
                    s.dist[1] = s.dist[0];
                    s.dist[0] = distance;
                }
                if (copyLen > remaining) revert BrotliInvalid(COPY);
                remaining -= copyLen;
                uint256 n = need - s.len;
                if (copyLen < n) n = copyLen;
                bytes memory out = s.out;
                uint256 pos = s.len;
                for (uint256 i; i < n; ++i) {
                    out[pos + i] = out[pos + i - distance];
                }
                s.len = pos + n;
            }
        }
    }

    function _distance(State memory s, uint256 code, uint256 npostfix, uint256 ndirect)
        private
        pure
        returns (uint256 d)
    {
        unchecked {
            if (code < 16) {
                // recent distances: 0-3 index the ring, 4-15 are last or second-to-last +- 1..3
                if (code < 4) return s.dist[code];
                uint256 k = (code - 4) % 6;
                uint256 base = s.dist[code < 10 ? 0 : 1];
                uint256 delta = (k >> 1) + 1;
                if (k & 1 == 1) return base + delta;
                if (base <= delta) revert BrotliInvalid(DISTANCE);
                return base - delta;
            }
            if (code < 16 + ndirect) return code - 15;
            uint256 x = code - ndirect - 16;
            uint256 nbits = 1 + (x >> (npostfix + 1));
            uint256 offset = ((2 + ((x >> npostfix) & 1)) << nbits) - 4;
            d = ((offset + _bits(s.r, nbits)) << npostfix) + (x & ((1 << npostfix) - 1)) + ndirect + 1;
        }
    }

    function _literalContext(State memory s, uint256 mode) private pure returns (uint256) {
        unchecked {
            uint256 len = s.len;
            bytes memory out = s.out;
            uint256 p1 = len > 0 ? uint8(out[len - 1]) : 0;
            if (mode == 0) return p1 & 63;
            if (mode == 1) return p1 >> 2;
            uint256 p2 = len > 1 ? uint8(out[len - 2]) : 0;
            uint256 base = mode == 2 ? 0 : 512;
            bytes memory lut = s.lut;
            return uint8(lut[base + p1]) | uint8(lut[base + 256 + p2]);
        }
    }

    function _switchBlock(Reader memory r, MetaBlock memory m, uint256 i) private pure {
        unchecked {
            uint256 t = _decodeSymbol(r, m.typeCodes[i]);
            if (t == 0) t = m.prevType[i];
            else if (t == 1) t = m.blockType[i] + 1;
            else t -= 2;
            if (t >= m.nbl[i]) t -= m.nbl[i];
            m.prevType[i] = m.blockType[i];
            m.blockType[i] = t;
            m.blockLen[i] = _blockLength(r, m.lenCodes[i]);
        }
    }

    function _blockLength(Reader memory r, Code memory c) private pure returns (uint256) {
        uint256 sym = _decodeSymbol(r, c);
        return _word16(BLOCK_BASE_0, BLOCK_BASE_1, sym) + _bits(r, _byte(BLOCK_EXTRA, sym));
    }

    function _contextMap(Reader memory r, uint256 size, uint256 trees) private pure returns (bytes memory map) {
        unchecked {
            map = new bytes(size);
            if (trees < 2) return map;
            uint256 rleMax = _bit(r) != 0 ? _bits(r, 4) + 1 : 0;
            Code memory c = _readCode(r, trees + rleMax);
            for (uint256 i; i < size;) {
                uint256 sym = _decodeSymbol(r, c);
                if (sym == 0) {
                    ++i;
                } else if (sym <= rleMax) {
                    uint256 run = (1 << sym) + _bits(r, sym);
                    if (i + run > size) revert BrotliInvalid(CONTEXT_MAP);
                    i += run; // zeros
                } else {
                    map[i++] = bytes1(uint8(sym - rleMax));
                }
            }
            if (_bit(r) != 0) {
                // inverse move-to-front
                bytes memory mtf = new bytes(256);
                for (uint256 i; i < 256; ++i) {
                    mtf[i] = bytes1(uint8(i));
                }
                assembly ("memory-safe") {
                    let m := add(mtf, 32)
                    let p := add(map, 32)
                    for { let end := add(p, size) } lt(p, end) { p := add(p, 1) } {
                        let k := byte(0, mload(p))
                        let v := byte(0, mload(add(m, k)))
                        mstore8(p, v)
                        for {} k { k := sub(k, 1) } { mstore8(add(m, k), byte(0, mload(add(m, sub(k, 1))))) }
                        mstore8(m, v)
                    }
                }
            }
        }
    }

    function _readCodes(Reader memory r, uint256 n, uint256 alphabet) private pure returns (Code[] memory codes) {
        codes = new Code[](n);
        for (uint256 i; i < n; ++i) {
            codes[i] = _readCode(r, alphabet);
        }
    }

    function _readCode(Reader memory r, uint256 alphabet) private pure returns (Code memory c) {
        unchecked {
            uint256 hskip = _bits(r, 2);
            if (hskip == 1) {
                // simple: 1-4 symbols with fixed lengths
                uint256 nsym = _bits(r, 2) + 1;
                uint256 width;
                for (uint256 x = alphabet - 1; x != 0; x >>= 1) {
                    ++width;
                }
                uint256[4] memory syms;
                for (uint256 i; i < nsym; ++i) {
                    uint256 sym = _bits(r, width);
                    if (sym >= alphabet) revert BrotliInvalid(SIMPLE_CODE);
                    for (uint256 j; j < i; ++j) {
                        if (syms[j] == sym) revert BrotliInvalid(SIMPLE_CODE);
                    }
                    syms[i] = sym;
                }
                if (nsym == 1) {
                    c.single = syms[0] + 1;
                    return c;
                }
                // lengths in order of appearance, 4 bits each
                uint256 shape = nsym == 2 ? 0x11 : nsym == 3 ? 0x221 : _bit(r) != 0 ? 0x3321 : 0x2222;
                c.lengths = new bytes(alphabet);
                for (uint256 i; i < nsym; ++i) {
                    uint256 len = (shape >> (4 * i)) & 15;
                    c.lengths[syms[i]] = bytes1(uint8(len));
                    c.counts += 1 << (len << 4);
                }
                c.total = nsym;
                return c;
            }
            // complex: code lengths coded with a code-length code (lengths <= 5)
            uint256 clLengths; // byte per symbol
            uint256 space = 32;
            uint256 numCodes;
            uint256 last;
            for (uint256 i = hskip; i < 18 && space > 0; ++i) {
                // fixed code (decode.c kCodeLengthPrefixValue), a bit at a time
                uint256 v;
                uint256 p = _bit(r);
                p |= _bit(r) << 1;
                if (p != 3) v = (0x030400 >> (8 * p)) & 0xff;
                else if (_bit(r) == 0) v = 2;
                else v = _bit(r) != 0 ? 5 : 1;
                if (v != 0) {
                    uint256 sym = _byte(CODE_LENGTH_ORDER, i);
                    clLengths |= v << (sym << 3);
                    if (32 >> v > space) revert BrotliInvalid(CODE_LENGTH_CODE);
                    space -= 32 >> v;
                    ++numCodes;
                    last = sym;
                }
            }
            if (numCodes != 1 && space != 0) revert BrotliInvalid(CODE_LENGTH_CODE);
            // entry by the next 5 bits: symbol | length << 5; a single code has length 0
            uint256 table = numCodes == 1 ? _repeatByte(last) : _shortTable(clLengths);
            bytes memory lengths = new bytes(alphabet);
            uint256 counts;
            uint256 total;
            uint256 symbol;
            uint256 prev = 8; // last nonzero length
            uint256 repeat;
            uint256 repeatLen;
            space = 32768;
            while (symbol < alphabet && space > 0) {
                uint256 e = _byte(table, _peek(r) & 31);
                uint256 pos = r.pos + (e >> 5);
                if (pos > r.end) revert BrotliInvalid(TRUNCATED);
                r.pos = pos;
                uint256 cl = e & 31;
                if (cl < 16) {
                    repeat = 0;
                    if (cl != 0) {
                        _setByte(lengths, symbol, cl);
                        counts += 1 << (cl << 4);
                        ++total;
                        prev = cl;
                        if (32768 >> cl > space) revert BrotliInvalid(CODE_LENGTHS);
                        space -= 32768 >> cl;
                    }
                    ++symbol;
                    continue;
                }
                uint256 extra = cl == 16 ? 2 : 3;
                uint256 len = cl == 16 ? prev : 0;
                if (repeatLen != len) {
                    repeat = 0;
                    repeatLen = len;
                }
                uint256 old = repeat;
                if (repeat > 0) repeat = (repeat - 2) << extra;
                repeat += _bits(r, extra) + 3;
                uint256 delta = repeat - old;
                if (symbol + delta > alphabet) revert BrotliInvalid(CODE_LENGTHS);
                if (repeatLen != 0) {
                    assembly ("memory-safe") {
                        let p := add(add(lengths, 32), symbol)
                        for { let end := add(p, delta) } lt(p, end) { p := add(p, 1) } { mstore8(p, repeatLen) }
                    }
                    counts += delta << (repeatLen << 4);
                    total += delta;
                    uint256 used = delta * (32768 >> repeatLen);
                    if (used > space) revert BrotliInvalid(CODE_LENGTHS);
                    space -= used;
                }
                symbol += delta; // zeros are already zero
            }
            if (space != 0) revert BrotliInvalid(CODE_LENGTHS);
            c.lengths = lengths;
            c.counts = counts;
            c.total = total;
        }
    }

    /// @dev Canonical code lengths (byte per symbol, 18 symbols, lengths <= 5) as a table by the next
    ///      5 bits read: entry = symbol | length << 5 (codes are read MSB first, bits arrive LSB first).
    function _shortTable(uint256 lengths) private pure returns (uint256 table) {
        unchecked {
            uint256 counts; // byte per length
            for (uint256 sym; sym < 18; ++sym) {
                uint256 len = _byte(lengths, sym);
                if (len != 0) counts += 1 << (len << 3);
            }
            uint256 next; // first code per length, byte each (deflate's next_code)
            uint256 code;
            for (uint256 len = 1; len <= 5; ++len) {
                code = (code + _byte(counts, len - 1)) << 1;
                next |= code << (len << 3);
            }
            for (uint256 sym; sym < 18; ++sym) {
                uint256 len = _byte(lengths, sym);
                if (len == 0) continue;
                uint256 c = _byte(next, len);
                next += 1 << (len << 3);
                uint256 rev;
                for (uint256 i; i < len; ++i) {
                    rev |= ((c >> i) & 1) << (len - 1 - i);
                }
                for (uint256 idx = rev; idx < 32; idx += 1 << len) {
                    table |= (sym | (len << 5)) << (idx << 3);
                }
            }
        }
    }

    function _repeatByte(uint256 b) private pure returns (uint256) {
        return b * 0x0101010101010101010101010101010101010101010101010101010101010101;
    }

    function _setByte(bytes memory v, uint256 i, uint256 b) private pure {
        assembly ("memory-safe") {
            mstore8(add(add(v, 32), i), b)
        }
    }

    /// @dev Canonical order: by length, then symbol.
    function _build(Code memory c) private pure {
        unchecked {
            bytes memory lengths = c.lengths;
            uint256 counts = c.counts;
            // offsets[len] = number of symbols with a shorter length
            uint256 offsets;
            uint256 sum;
            for (uint256 len = 1; len < 16; ++len) {
                offsets |= sum << (len << 4);
                sum += (counts >> (len << 4)) & 0xffff;
            }
            bytes memory symbols = new bytes(c.total << 1);
            assembly ("memory-safe") {
                let n := mload(lengths)
                let src := add(lengths, 32)
                let dst := add(symbols, 32)
                for { let i := 0 } lt(i, n) { i := add(i, 32) } {
                    let w := mload(add(src, i))
                    if w {
                        for { let j := 0 } lt(j, 32) { j := add(j, 1) } {
                            let len := byte(j, w)
                            let k := add(i, j)
                            if and(gt(len, 0), lt(k, n)) {
                                let sh := shl(4, len)
                                let at := shl(1, and(shr(sh, offsets), 0xffff))
                                offsets := add(offsets, shl(sh, 1))
                                mstore8(add(dst, at), shr(8, k))
                                mstore8(add(dst, add(at, 1)), and(k, 0xff))
                            }
                        }
                    }
                }
            }
            c.symbols = symbols;
        }
    }

    function _decodeSymbol(Reader memory r, Code memory c) private pure returns (uint256) {
        unchecked {
            if (c.single != 0) return c.single - 1;
            if (c.symbols.length == 0) _build(c);
            uint256 counts = c.counts;
            uint256 peek = _peek(r);
            uint256 code;
            uint256 first;
            uint256 index;
            for (uint256 len = 1; len < 16; ++len) {
                code |= (peek >> (len - 1)) & 1;
                uint256 count = (counts >> (len << 4)) & 0xffff;
                if (code < first + count) {
                    uint256 pos = r.pos + len;
                    if (pos > r.end) revert BrotliInvalid(TRUNCATED);
                    r.pos = pos;
                    uint256 at = (index + code - first) << 1;
                    bytes memory symbols = c.symbols;
                    uint256 sym;
                    assembly ("memory-safe") {
                        sym := shr(240, mload(add(add(symbols, 32), at)))
                    }
                    return sym;
                }
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            revert BrotliInvalid(PREFIX_CODE);
        }
    }

    // -- bits (LSB first)

    /// @dev The next 25+ bits, unchecked: callers check what they consume against `end`.
    function _peek(Reader memory r) private pure returns (uint256 v) {
        bytes memory data = r.data;
        uint256 pos = r.pos;
        assembly ("memory-safe") {
            let w := mload(add(add(data, 32), shr(3, pos)))
            let le := or(or(byte(0, w), shl(8, byte(1, w))), or(shl(16, byte(2, w)), shl(24, byte(3, w))))
            v := shr(and(pos, 7), le)
        }
    }

    function _bits(Reader memory r, uint256 n) private pure returns (uint256) {
        unchecked {
            if (n == 0) return 0;
            uint256 pos = r.pos + n;
            if (pos > r.end) revert BrotliInvalid(TRUNCATED);
            uint256 v = _peek(r) & ((1 << n) - 1);
            r.pos = pos;
            return v;
        }
    }

    function _bit(Reader memory r) private pure returns (uint256) {
        return _bits(r, 1);
    }

    function _varLenUint8(Reader memory r) private pure returns (uint256) {
        unchecked {
            if (_bit(r) == 0) return 0;
            uint256 n = _bits(r, 3);
            return n != 0 ? (1 << n) + _bits(r, n) : 1;
        }
    }

    function _align(Reader memory r) private pure {
        while (r.pos & 7 != 0) {
            if (_bit(r) != 0) revert BrotliInvalid(PADDING);
        }
    }

    function _push(State memory s, uint256 b) private pure {
        s.out[s.len++] = bytes1(uint8(b));
    }

    function _byte(uint256 table, uint256 i) private pure returns (uint256) {
        return (table >> (i << 3)) & 0xff;
    }

    function _word16(uint256 lo, uint256 hi, uint256 i) private pure returns (uint256) {
        return i < 16 ? (lo >> (i << 4)) & 0xffff : (hi >> ((i - 16) << 4)) & 0xffff;
    }
}
