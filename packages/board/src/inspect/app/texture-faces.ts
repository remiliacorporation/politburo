// Where each mob's side-of-head sits in the game's entity texture, and which file
// each sprite item is. These rectangles are ours. The PNGs are not: the inspector
// reads them from a directory the person points at, and nothing here ships one.

export type TextureRect = { path: string; x: number; y: number; w: number; h: number }

/**
 * The side face of a box drawn at texture origin `(u, v)`.
 * A box of width × height × depth lays its side out as depth × height,
 * starting one depth below the origin.
 */
function side(path: string, u: number, v: number, depth: number, height: number): TextureRect {
  return { path, x: u, y: v + depth, w: depth, h: height }
}

/** The side of the head for every species in the default pools. */
export const speciesTextures: Record<string, TextureRect> = {
  COW: side('entity/cow/temperate_cow.png', 0, 0, 6, 8),
  SHEEP: side('entity/sheep/sheep.png', 0, 0, 8, 6),
  MOOSH: side('entity/cow/red_mooshroom.png', 0, 0, 6, 8),
  CHICKEN: side('entity/chicken/temperate_chicken.png', 0, 0, 3, 6),
  PIG: side('entity/pig/temperate_pig.png', 0, 0, 8, 8),
  FOX: side('entity/fox/fox.png', 1, 5, 6, 6),
  CAT: side('entity/cat/tabby.png', 0, 0, 5, 4),
  OCELOT: side('entity/cat/ocelot.png', 0, 0, 5, 4),
  BAT: side('entity/bat.png', 0, 7, 2, 3),
  AXOLOTL: side('entity/axolotl/axolotl_lucy.png', 0, 1, 5, 5),
  FROG: side('entity/frog/temperate_frog.png', 0, 13, 9, 3),
  TURTLE: side('entity/turtle/big_sea_turtle.png', 3, 0, 6, 5),
  TADPOLE: side('entity/tadpole/tadpole.png', 0, 0, 3, 2),
  PUFFER: side('entity/fish/pufferfish.png', 0, 0, 8, 8),
  PARROT: side('entity/parrot/parrot_red_blue.png', 2, 2, 2, 3),
  RABBIT: side('entity/rabbit/brown.png', 0, 16, 5, 5),
  SQUID: side('entity/squid/squid.png', 0, 0, 12, 16),
  COD: side('entity/fish/cod.png', 11, 0, 3, 4),
  SALMON: side('entity/fish/salmon.png', 22, 0, 3, 4),
  ALLAY: side('entity/allay/allay.png', 0, 0, 5, 5),
  DONKEY: side('entity/horse/donkey.png', 0, 13, 7, 5),
  MULE: side('entity/horse/mule.png', 0, 13, 7, 5),
  CAMEL: side('entity/camel/camel.png', 21, 0, 7, 14),
  HORSE: side('entity/horse/horse_brown.png', 0, 13, 7, 5),
  SKORSE: side('entity/horse/horse_skeleton.png', 0, 13, 7, 5),
  ZORSE: side('entity/horse/horse_zombie.png', 0, 13, 7, 5),
  VILLAGER: side('entity/villager/villager.png', 0, 0, 8, 10),
  SNOWMAN: side('entity/snow_golem.png', 0, 0, 8, 8),
  BEE: side('entity/bee/bee.png', 0, 0, 10, 7),
  DOLPHIN: side('entity/dolphin.png', 0, 0, 6, 7),
  WOLF: side('entity/wolf/wolf.png', 0, 0, 4, 6),
  POLAR: side('entity/bear/polarbear.png', 0, 0, 7, 7),
  ENDERMAN: side('entity/enderman/enderman.png', 0, 0, 8, 8),
  SPIDER: side('entity/spider/spider.png', 32, 4, 8, 8),
  GOAT: side('entity/goat/goat.png', 34, 46, 10, 7),
  PIGLIN: side('entity/piglin/piglin.png', 0, 0, 8, 8),
  LLAMA: side('entity/llama/creamy.png', 0, 0, 9, 4),
  PANDA: side('entity/panda/panda.png', 0, 6, 9, 10),
  CAVSPIDR: side('entity/spider/cave_spider.png', 32, 4, 8, 8),
  GOLEM: side('entity/iron_golem/iron_golem.png', 0, 0, 8, 10),
  PIGMAN: side('entity/piglin/zombified_piglin.png', 0, 0, 8, 8),
  CREEPER: side('entity/creeper/creeper.png', 0, 0, 8, 8),
  HOGLIN: side('entity/hoglin/hoglin.png', 61, 1, 19, 6),
  ZOGLIN: side('entity/hoglin/zoglin.png', 61, 1, 19, 6),
  BRUTE: side('entity/piglin/piglin_brute.png', 0, 0, 8, 8),
  GUARDIAN: side('entity/guardian.png', 0, 0, 16, 12),
  SHULKER: side('entity/shulker/shulker.png', 0, 52, 6, 6),
  WITCH: side('entity/witch.png', 0, 0, 8, 10),
  SKELETON: side('entity/skeleton/skeleton.png', 0, 0, 8, 8),
  STRAY: side('entity/skeleton/stray.png', 0, 0, 8, 8),
  WITHSKEL: side('entity/skeleton/wither_skeleton.png', 0, 0, 8, 8),
  BLAZE: side('entity/blaze.png', 0, 0, 8, 8),
  GHAST: side('entity/ghast/ghast.png', 0, 0, 16, 16),
  PHANTOM: side('entity/phantom.png', 0, 0, 5, 3),
  PILLAGER: side('entity/illager/pillager.png', 0, 0, 8, 10),
  VINDICTR: side('entity/illager/vindicator.png', 0, 0, 8, 10),
  EVOKER: side('entity/illager/evoker.png', 0, 0, 8, 10),
  VEX: side('entity/illager/vex.png', 0, 0, 5, 5),
  ZOMBIE: side('entity/zombie/zombie.png', 0, 0, 8, 8),
  HUSK: side('entity/zombie/husk.png', 0, 0, 8, 8),
  DROWNED: side('entity/zombie/drowned.png', 0, 0, 8, 8),
  ZILLAGER: side('entity/zombie_villager/zombie_villager.png', 0, 0, 8, 10),
  SILVER: side('entity/silverfish.png', 0, 0, 2, 2),
  MITE: side('entity/endermite.png', 0, 0, 2, 3),
  SLIME: side('entity/slime/slime.png', 0, 0, 8, 8),
  MAGMA: side('entity/slime/magmacube.png', 0, 0, 8, 8),
  DRAGON: side('entity/enderdragon/dragon.png', 112, 30, 16, 16),
  WITHER: side('entity/wither/wither.png', 0, 0, 8, 8),
  WARDEN: side('entity/warden/warden.png', 0, 32, 10, 16),
  ELDERG: side('entity/guardian_elder.png', 0, 0, 16, 12),
}

/** The item texture for every sprite in the default pools. The whole file is the icon. */
export const itemTextures: Record<string, string> = {
  PICKAXE: 'item/diamond_pickaxe.png',
  AXE: 'item/diamond_axe.png',
  SHOVEL: 'item/diamond_shovel.png',
  HOE: 'item/diamond_hoe.png',
  ANVIL: 'block/anvil.png',
  SHEARS: 'item/shears.png',
  FLINT: 'item/flint.png',
  SWORD: 'item/diamond_sword.png',
  BOW: 'item/bow.png',
  TRIDENT: 'item/trident.png',
  COMPASS: 'item/compass_16.png',
  CLOCK: 'item/clock_00.png',
  MAP: 'item/map.png',
  BOOK: 'item/book.png',
  QUILL: 'item/feather.png',
  SIGN: 'item/oak_sign.png',
}
