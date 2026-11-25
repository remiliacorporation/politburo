// Pixel heads and tools for the party name pools. Each species is an 8×8 face; the cube's
// side and top are shaded from that face. Each item is a flat 8×8 tool, drawn at 2×.
// The grids are original. They are not a game's texture files.

const palette: Record<string, string> = {
  k: '#1b1b1b',
  w: '#f4f1ea',
  n: '#8d5a34',
  h: '#5c3a22',
  c: '#f0d8b0',
  p: '#f0a0b4',
  r: '#d24b4b',
  o: '#e07a2f',
  y: '#f0c14a',
  g: '#2f6b3a',
  b: '#3c6eb0',
  t: '#2f8f8a',
  u: '#6a4a9a',
  d: '#5c6370',
  s: '#c5ccd4',
  i: '#d7eef5',
  a: '#efe6d2',
  f: '#e36a2c',
}

const speciesArt: Record<string, string> = {
  COW: `
hnnccnnh
nccccccn
ncwkkcwn
nccccccn
ncppppcn
ncpkkpcn
nccccccn
nnnnnnnn`,
  SHEEP: `
wwwwwwww
wddwwddw
wwdwwdww
wwccccww
wwckkcww
wwcppcww
wwccccww
wwwwwwww`,
  MOOSH: `
rrwwrrww
rrrrrrrr
nccccccn
ncwkkcwn
nccccccn
ncppppcn
ncpkkpcn
nnnnnnnn`,
  CHICKEN: `
rrrrrrrr
yyyyyyyy
yywyywyy
yyyyyyyy
yyoooooy
yyyooyyy
yyyyyyyy
yyyyyyyy`,
  PIG: `
pppppppp
pwwppwwp
pppppppp
ppddddpp
ppdkkdpp
ppddddpp
pppppppp
pppppppp`,
  FOX: `
kkoooook
oooooooo
owwkkwwo
oooooooo
oowwwwoo
oowkkwoo
oooooooo
oooooooo`,
  CAT: `
kddkkddk
dddddddd
dwkkkwdw
dddddddd
ddppppdd
ddpkkpdd
dddddddd
dddddddd`,
  OCELOT: `
yyyyyyyy
ykyyykyy
yywyywyy
yyyyyyyy
yyyppyyy
ykyyykyy
yyyyyyyy
ykyyykyy`,
  BAT: `
ukkukkuu
uuuuuuuu
uwuwwuwu
uuuuuuuu
uukkkuuu
uuwwwwuu
ukukukuk
uuuuuuuu`,
  AXOLOTL: `
rppppppr
pppppppp
ppwppwpp
pppppppp
pprkkprp
pppppppp
pppppppp
pppppppp`,
  FROG: `
gggggggg
gywyywyg
gggggggg
ggkkkkgg
gggggggg
gggggggg
gkggggkg
gggggggg`,
  TURTLE: `
gggggggg
ggyggygg
gggggggg
ggccccgg
ggcwwcgg
ggccccgg
gggggggg
nnnnnnnn`,
  TADPOLE: `
kkkkkkkk
kddddddk
kddddwwk
kddddwwk
kddddddk
kddddddk
kddddddk
kkkkkkkk`,
  PUFFER: `
ykyyyyyk
kyyyyyyk
yywyywyy
yyyyyyyy
yykkkkky
yyyyyyyy
kyyyyyyk
ykyyyyyk`,
  PARROT: `
rrrrrrrr
rrwrrwrr
rrrrrrrr
rryyyyyr
rrggggrr
rrbbbbbr
rrrrrrrr
rrrrrrrr`,
  RABBIT: `
pccccccp
cccccccc
ccwccwcc
cccccccc
ccppppcc
ccwwwwcc
cccccccc
cccccccc`,
  SQUID: `
bbbbbbbb
bbwbbwbb
bbbbbbbb
bbkkkkbb
bbbbbbbb
bbbbbbbb
bbkkkkbb
bbbbbbbb`,
  COD: `
ssssssss
sswsswss
ssssssss
ssddddss
ssssssss
sskkkkss
ssssssss
ssssssss`,
  SALMON: `
oooooooo
oowoowoo
oooooooo
oooooook
oooooooo
oookkkko
oooooooo
oooooooo`,
  ALLAY: `
iiiiiiii
iiwiiwii
iiiiiiii
iibbbbbi
iiiiiiii
iiwwwwii
iiiiiiii
iibbbbbi`,
  DONKEY: `
dddddddd
dwwddwwd
dddddddd
ddhhhhdd
dddddddd
ddkkkkdd
dddddddd
hhhhhhhh`,
  MULE: `
nnnnnnnn
nwwccwwn
cccccccc
ccnnnncc
cccccccc
cckkkkcc
cccccccc
nnnnnnnn`,
  CAMEL: `
ccccnncc
cccccccc
ccwccwcc
cccccccc
ccnnnncc
ccnccncc
cccccccc
nnnnnnnn`,
  HORSE: `
nnnnnnnn
nwccccwn
cccccccc
cchhhhcc
ccwwwwcc
cckkkkcc
cccccccc
hhhhhhhh`,
  SKORSE: `
aaaaaaaa
awkkwkka
aaaaaaaa
aakkkkaa
aaaaaaaa
aakkkkaa
aaaaaaaa
dddddddd`,
  ZORSE: `
kkwkkwkk
wwkwwkww
kkwkkwkk
wwwwwwww
kkwwwwkk
wwkkkkww
kkwkkwkk
wwwwwwww`,
  VILLAGER: `
ccccnncc
cccccccc
cchhhhcc
cccccccc
ccnnnncc
ccnccncc
ccddddcc
gggggggg`,
  SNOWMAN: `
wwwwwwww
wwkwwkww
wwwwwwww
wwwoowww
wwwwwwww
wwkkkkww
wwwwwwww
kkkkkkkk`,
  BEE: `
kkyyyykk
yyyyyyyy
kkkkkkkk
yywyywyy
yyyyyyyy
kkkkkkkk
yyyyyyyy
kkkkkkkk`,
  DOLPHIN: `
tttttttt
ttwttwtt
tttttttt
tttttttk
tttttttt
ttkkkktt
tttttttt
tttttttt`,
  WOLF: `
dddddddd
dwwddwwd
dddddddd
ddwwwwdd
ddwkkwwd
ddwwwwdd
dddddddd
wwwwwwww`,
  POLAR: `
wwwwwwww
wkkwwkkw
wwwwwwww
wwkkkkww
wwkwwkww
wwkkkkww
wwwwwwww
wwwwwwww`,
  ENDERMAN: `
kkkkkkkk
kuuuuukk
kkkkkkkk
kkkkkkkk
kkkkkkkk
kkkkkkkk
kkkkkkkk
kkkkkkkk`,
  SPIDER: `
kkkkkkkk
krkrrkrk
kkkkkkkk
krkrrkrk
kkkkkkkk
kkkkkkkk
kkkkkkkk
kkkkkkkk`,
  GOAT: `
kwwwwwwk
wwwwwwww
wwkwwkww
wwwwwwww
wwccccww
wwcwwcww
wwwwwwww
wwwwwwww`,
  PIGLIN: `
yyyyyyyy
pppppppp
ppwppwpp
pppppppp
ppddddpp
ppdkkdpp
ppddddpp
yyyyyyyy`,
  LLAMA: `
rrccccrr
cccccccc
ccwccwcc
cccccccc
ccnnnncc
ccnccncc
cccccccc
rrrrrrrr`,
  PANDA: `
kwwwwwwk
wwwwwwww
wkwwwwkw
wwwwwwww
wwkkkkww
wwkwwkww
wwwwwwww
wwwwwwww`,
  CAVSPIDR: `
dddddddd
dbdbbddb
dddddddd
dbdbbddb
dddddddd
bbbbbbbb
dddddddd
dddddddd`,
  GOLEM: `
ssssssss
sswsswss
ssssssss
ssnnnnss
ssnssnss
ssnnnnss
ssssssss
ssssssss`,
  PIGMAN: `
gggggggg
gpwgpwgp
gggggggg
ggddddgg
ggdkkdgg
ggddddgg
gggggggg
bbbbbbbb`,
  CREEPER: `
gggggggg
gkggggkg
gkkggkkg
gggggggg
ggkggkgg
ggkkkkgg
gggggggg
gggggggg`,
  HOGLIN: `
nnnnnnnn
nwnnnwnn
nnnnnnnn
nnwwwwwn
nnwkkwnn
nnwwwwwn
wwwnnwww
nnnnnnnn`,
  ZOGLIN: `
gggggggg
gwgggwgg
gggggggg
ggwwwwwg
ggwkkwwg
ggwwwwwg
wwgggwww
gggggggg`,
  BRUTE: `
yyyyyyyy
nnnnnnnn
nnwnnwyn
nnnnnnnn
nndddddn
nndkkddn
nndddddn
yyyyyyyy`,
  GUARDIAN: `
tttttttt
tttttwwt
ttkkkktt
ttkwwktt
ttkkkktt
tttttttt
tttttwwt
tttttttt`,
  SHULKER: `
uuuuuuuu
uuuuuuuu
uukkkkuu
uukyykuu
uukkkkuu
uuuuuuuu
uuuuuuuu
yyyyyyyy`,
  WITCH: `
uuuuuuuu
uuccccuu
cccccccc
cchhhhcc
ccggggcc
ccgkkggc
cccccccc
uuuuuuuu`,
  SKELETON: `
aaaaaaaa
akkwwkka
aaaaaaaa
aakkkkaa
aaaaaaaa
aakkkkaa
aaaaaaaa
aaaaaaaa`,
  STRAY: `
iiiiiiii
ikkwwkki
iiiiiiii
iikkkiii
iiiiiiii
iikkkiii
iiiiiiii
bbbbbbbb`,
  WITHSKEL: `
kkkkkkkk
kwwkkwwk
kkkkkkkk
kkkkkkkk
kwwkkwwk
kkkkkkkk
kwwkkwwk
kkkkkkkk`,
  BLAZE: `
yyyyyyyy
ykkkkkyy
yyyyyyyy
yywyywyy
yyyyyyyy
ykkkkkyy
yyyyyyyy
ffyyyyff`,
  GHAST: `
wwwwwwww
wkwkkwkw
wwwwwwww
wwkkkkww
wwkwwkww
wwkkkkww
wwwwwwww
wwwwwwww`,
  PHANTOM: `
tttttttt
ttgttgtt
tttttttt
ttkkkktt
tttttttt
kkkkkkkk
tttttttt
tttttttt`,
  PILLAGER: `
dddddddd
dkkkkkkd
dddddddd
ddwddwdd
ddnnnndd
ddnccndd
dddddddd
ssssssss`,
  VINDICTR: `
nnnnnnnn
nkkkkkkn
nnnnnnnn
nnbnnbnn
nnknnnnn
nncccnnn
nnnnnnnn
bbbbbbbb`,
  EVOKER: `
kkkkkkkk
kcccccck
cccccccc
cchhhhcc
ccykkccy
cccccccc
kkkkkkkk
yyyyyyyy`,
  VEX: `
iiiiiiii
iikwwkii
iiiiiiii
iikkkkii
iiiiiiii
wwiiiiww
iiiiiiii
wwiiiiww`,
  ZOMBIE: `
gggggggg
gkwgkwkg
gggggggg
ggkkkkgg
gggggggg
ggkkkkgg
gggggggg
bbbbbbbb`,
  HUSK: `
ccccnncc
cckcckcc
cccccccc
cckkkkcc
cccccccc
cckkkkcc
cccccccc
nnnnnnnn`,
  DROWNED: `
tttttttt
tktkktkt
tttttttt
ttkkkktt
tttttttt
ttkkkktt
tttttttt
bbbbbbbb`,
  ZILLAGER: `
gggggggg
ggwggwgg
gghhhhgg
gggggggg
ggnnnngg
ggnccngg
gggggggg
gggggggg`,
  SILVER: `
ssssssss
ssskksss
ssssssss
kksssskk
ssssssss
ssskksss
ssssssss
ssssssss`,
  MITE: `
uuuuuuuu
uukkuuuu
kuuuuuuk
uuuuuuuu
kuuuuuuk
uukkuuuu
uuuuuuuu
uuuuuuuu`,
  SLIME: `
gggggggg
gyyyyyyg
gywyywyg
gyyyyyyg
gyykkyyg
gyyyyyyg
gggggggg
gggggggg`,
  MAGMA: `
ffffffff
fkkkkkkf
fkyykykf
fkkkkkkf
fkkkkkkf
fykkkkfy
ffffffff
kkkkkkkk`,
  DRAGON: `
kkuuuukk
kkkkkkkk
kkwkkwkk
kkkkkkkk
kkuuuukk
kkkkkkkk
kkkkkkkk
uuuuuuuu`,
  WITHER: `
kkkkkkkk
wwkwwkww
kkkkkkkk
kwwwwwwk
kkkkkkkk
kwwwwwwk
kkkkkkkk
kkkkkkkk`,
  WARDEN: `
kttttttk
tttttttt
tcccccct
tttttttt
tttttttt
tcccccct
tttttttt
kttttttk`,
  ELDERG: `
tttttttt
tytttwty
tkkkkttt
tkwwwktt
tkkkkttt
tytttwty
tttttttt
yyyyyyyy`,
}

const itemArt: Record<string, string> = {
  PICKAXE: `
..ssss..
...ssss.
....ss..
...hh...
..hh....
.hh.....
hh......
h.......`,
  AXE: `
.ssss...
ssss....
.ss.....
..hh....
...hh...
....hh..
.....hh.
......h.`,
  SHOVEL: `
..sss...
..sss...
..sss...
...h....
...h....
...h....
...h....
..hhh...`,
  HOE: `
sssss...
ssss....
..h.....
...h....
....h...
.....h..
......h.
.......h`,
  ANVIL: `
dddddddd
ssssssss
skkkkks.
.skkks..
.skkks..
skkkkks.
ssssssss
dddddddd`,
  SHEARS: `
ss....ss
sks..sks
.ss..ss.
..ssss..
..ssss..
.ss..ss.
sks..sks
ss....ss`,
  FLINT: `
...s....
..sss...
.ssks...
sssks...
.ssss...
..sss...
...h....
...hh...`,
  SWORD: `
...s....
...s....
...s....
...s....
..sss...
...y....
...h....
..hhh...`,
  BOW: `
h....s..
.h..s...
..h.s...
...hs...
...hs...
..h.s...
.h..s...
h....s..`,
  TRIDENT: `
s..s..s.
s..s..s.
sssssss.
...s....
...s....
...s....
...s....
...h....`,
  COMPASS: `
.dddddd.
dwwwwwd.
dwkwkwd.
dwwrwwd.
dwwrwwd.
dwkwkwd.
dwwwwwd.
.dddddd.`,
  CLOCK: `
.yyyyyy.
ywwwwwwy
ywwkwwwy
ywwywwwy
ywwwkwwy
ywwwwwwy
ywwwwwwy
.yyyyyy.`,
  MAP: `
nnnnnnnn
nccccccn
ncgggccn
ncgggccn
nccccccn
nccrrccn
nccccccn
nnnnnnnn`,
  BOOK: `
.nnnnnn.
nccccccn
ncwwwwcn
ncwwwwcn
ncwwwwcn
ncwwwwcn
nccccccn
.nnnnnn.`,
  QUILL: `
.....ww.
....www.
...www..
..www...
.kkk....
kkk.....
kk......
k.......`,
  SIGN: `
nnnnnnnn
nccccccn
nccccccn
nckkkkcn
nnnnnnnn
...hh...
...hh...
...hh...`,
}

const FACE = 8
const DEPTH = 6
const NUMBERED = /^(?:[2-9]|[1-9][0-9]+)$/

function grid(name: string, art: string): string[] {
  const rows = art.split('\n').map((row) => row.trim()).filter((row) => row.length > 0)
  const bad = rows.length !== FACE || rows.some((row) => row.length !== FACE || [...row].some((cell) => cell !== '.' && palette[cell] === undefined))
  if (bad) throw new Error(`icon ${name} must be an 8x8 grid of palette colors: ${rows.map((row) => row.length).join(',')}`)
  return rows
}

const speciesFaces = new Map<string, string[]>(Object.entries(speciesArt).map(([name, art]) => [name, grid(name, art)]))
const itemFaces = new Map<string, string[]>(Object.entries(itemArt).map(([name, art]) => [name, grid(name, art)]))
const speciesByLength = [...speciesFaces.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))
const itemsByLength = [...itemFaces.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))

function shade(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number) => Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) * factor)))
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`
}

function rect(x: number, y: number, fill: string, size = 1): string {
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>`
}

function cube(rows: readonly string[]): string {
  const colorAt = (x: number, y: number) => palette[rows[y]![x]!]!
  const parts: string[] = []
  for (let depth = DEPTH - 1; depth >= 0; depth--) {
    for (let y = 0; y < FACE; y++) {
      parts.push(rect(FACE + depth, DEPTH + y - depth, shade(colorAt(FACE - 1, y), 0.62)))
    }
  }
  for (let depth = DEPTH - 1; depth >= 0; depth--) {
    for (let x = 0; x < FACE; x++) {
      parts.push(rect(x + depth, DEPTH - 1 - depth, shade(colorAt(x, 0), 1.18)))
    }
  }
  for (let y = 0; y < FACE; y++) {
    for (let x = 0; x < FACE; x++) parts.push(rect(x, DEPTH + y, colorAt(x, y)))
  }
  return parts.join('')
}

function flat(rows: readonly string[]): string {
  const parts: string[] = []
  for (let y = 0; y < FACE; y++) {
    for (let x = 0; x < FACE; x++) {
      const cell = rows[y]![x]!
      if (cell === '.') continue
      parts.push(rect(x * 2, y * 2, palette[cell]!, 2))
    }
  }
  return parts.join('')
}

const fallbackBody = flat(grid('fallback', `
dddddddd
dkkkkkkw
dkdddkwd
dkdkdkwd
dkdddkwd
dkkkkkkw
dwwwwwwd
dddddddd`))

function named(token: string, names: readonly string[]): string | null {
  for (const name of names) {
    if (!token.startsWith(name)) continue
    const rest = token.slice(name.length)
    if (rest === '' || NUMBERED.test(rest)) return name
  }
  return null
}

/** Species names the icon set draws. */
export function speciesNames(): readonly string[] {
  return [...speciesFaces.keys()].sort()
}

/** Item names the icon set draws. */
export function itemNames(): readonly string[] {
  return [...itemFaces.keys()].sort()
}

/**
 * The species in a mob id `<serial>-<SPECIES><n>` (`317-CAT`, `21-BEE2`). The suffix is the
 * allocator's: empty, or 2 and up. Null when the id is not that shape or the species is unknown.
 */
export function speciesOfMob(id: string): string | null {
  const match = /^([1-9][0-9]*)-([A-Z]+[0-9]*)$/.exec(id)
  if (!match) return null
  return named(match[2]!, speciesByLength)
}

/**
 * The item in a sprite id `<mob-id>.<ITEM><n>` (`317-CAT.PICKAXE`, `21-BEE2.AXE3`). Null when
 * the mob id or the item does not parse.
 */
export function itemOfSprite(id: string): string | null {
  const match = /^([1-9][0-9]*-[A-Z]+[0-9]*)\.([A-Z]+[0-9]*)$/.exec(id)
  if (!match || speciesOfMob(match[1]!) === null) return null
  return named(match[2]!, itemsByLength)
}

/**
 * The icon for a displayed actor name, when that name is a mob id or a sprite id.
 * `317-CAT via julian` is the cat; `21-BEE2.AXE` is the axe. Anything else is null.
 * The match is case-insensitive because a board handle can be lowercase.
 */
export function actorIcon(name: string): { label: string; svg: string } | null {
  const head = name.split(' via ')[0]?.trim() ?? ''
  if (head === '') return null
  const token = head.toUpperCase()
  const item = itemOfSprite(token)
  if (item) return { label: item, svg: iconFor(item, 16) }
  const species = speciesOfMob(token)
  if (species) return { label: species, svg: iconFor(species, 16) }
  return null
}

/** A species or item icon. An unknown name is a plain flat mark, not a head. */
export function iconFor(name: string, size: 16 | 64 = 16): string {
  const species = speciesFaces.get(name)
  const item = itemFaces.get(name)
  const body = species ? cube(species) : item ? flat(item) : fallbackBody
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`
}
