# Party config reference

Generated from `src/config/schema.json` and `src/config/defaults.json` by `packages/swarm/scripts/write-party-config-reference.mjs`.

`swarm config show` prints the merged tree. `swarm config validate` checks a party file, a repo file, or both. Built-in defaults load first. The party file deep-merges over them. The repo file deep-merges over that. Arrays replace. An unknown key fails validation.

A `*` under `secretary.questions` is one question name. A `*` under `trackers` is one `owner/repo` key. `[]` is one object in an array.

## Keys

### `party`

Type: object, required

Default: `{"id":"default","name":"The People's Party","colour":"#b3261e"}`

`planMob` reads `party.id` from the loaded tree. `swarm party add` uses the built-in `name` and `colour` when the id is `default` and the matching flag is omitted.

### `party.id`

Type: string matching `^[a-z][a-z0-9-]*$`, required

Default: `default`

`planMob` writes the loaded id into the mob brief.

### `party.name`

Type: string, required

Default: `The People's Party`

`swarm party add` uses the built-in name when the id is `default` and `--name` is omitted.

### `party.colour`

Type: string matching `^#[0-9a-fA-F]{6}$`, required

Default: `#b3261e`

`swarm party add` uses the built-in colour when the id is `default` and `--colour` is omitted.

### `names`

Type: object, required

Default:

```json
{
  "spawners": [
    "ZAVOD",
    "FABRIKA",
    "KOMBINAT",
    "KOLKHOZ",
    "SOVKHOZ",
    "ARTEL",
    "SHAKHTA",
    "TSEKH",
    "DOMNA",
    "KOTLOVAN",
    "PRORAB",
    "BRIGADIR",
    "MASTER",
    "NARKOM",
    "UDARNIK",
    "TREST",
    "GLAVK",
    "GOSPLAN",
    "NORMA",
    "SMENA",
    "OTDEL",
    "MOLOT",
    "SERP",
    "TRAKTOR",
    "TURBINA",
    "KRAN",
    "STAL",
    "GUDOK",
    "MAGNITKA",
    "URALMASH",
    "ZIL",
    "GAZ",
    "KAMAZ"
  ],
  "secretaries": [
    "Peggy",
    "Joan",
    "Dawn",
    "Ida",
    "Allison",
    "Lois",
    "Hildy",
    "Olive",
    "Clara",
    "Margie",
    "Kathy",
    "Jenny",
    "Scarlet",
    "Fran",
    "Betty",
    "Megan",
    "Sally",
    "Trudy",
    "Rachel",
    "Midge",
    "Faye",
    "Shirley",
    "Jane",
    "Bobbie",
    "Suzanne",
    "Sylvia",
    "Mona",
    "Marie",
    "Carla",
    "Diana",
    "Beth",
    "Rebecca",
    "Anna",
    "Joyce",
    "Bethany",
    "Helen",
    "Pima",
    "Anita",
    "Nan",
    "Toni",
    "Gloria"
  ],
  "mob_species": {
    "passive": {
      "audit": [
        "COW",
        "SHEEP",
        "MOOSH",
        "CHICKEN",
        "PIG"
      ],
      "research": [
        "FOX",
        "CAT",
        "OCELOT"
      ],
      "review": [
        "BAT",
        "AXOLOTL",
        "FROG",
        "TURTLE",
        "TADPOLE",
        "PUFFER"
      ],
      "status": [
        "PARROT",
        "RABBIT",
        "SQUID",
        "COD",
        "SALMON"
      ],
      "gather": [
        "ALLAY",
        "DONKEY",
        "MULE",
        "CAMEL",
        "HORSE",
        "SKORSE",
        "ZORSE"
      ],
      "plan": [
        "VILLAGER",
        "SNOWMAN"
      ]
    },
    "neutral": {
      "build": [
        "BEE",
        "DOLPHIN"
      ],
      "fix": [
        "WOLF",
        "POLAR"
      ],
      "refactor": [
        "ENDERMAN",
        "SPIDER"
      ],
      "sync": [
        "GOAT",
        "PIGLIN"
      ],
      "port": [
        "LLAMA"
      ],
      "docs": [
        "PANDA",
        "CAVSPIDR"
      ],
      "ci": [
        "GOLEM",
        "PIGMAN"
      ]
    },
    "hostile": {
      "integrate": [
        "CREEPER",
        "HOGLIN",
        "ZOGLIN",
        "BRUTE"
      ],
      "merge": [
        "GUARDIAN",
        "SHULKER",
        "WITCH"
      ],
      "revert": [
        "SKELETON",
        "STRAY",
        "WITHSKEL"
      ],
      "release": [
        "BLAZE",
        "GHAST",
        "PHANTOM"
      ],
      "raid": [
        "PILLAGER",
        "VINDICTR",
        "EVOKER",
        "VEX"
      ],
      "cleanup": [
        "ZOMBIE",
        "HUSK",
        "DROWNED",
        "ZILLAGER",
        "SILVER",
        "MITE",
        "SLIME",
        "MAGMA"
      ]
    },
    "boss": [
      "DRAGON",
      "WITHER",
      "WARDEN",
      "ELDERG"
    ]
  },
  "sprite_items": {
    "implement": [
      "PICKAXE",
      "AXE",
      "SHOVEL",
      "HOE"
    ],
    "fix": [
      "ANVIL",
      "SHEARS",
      "FLINT"
    ],
    "review": [
      "SWORD",
      "BOW",
      "TRIDENT"
    ],
    "verify": [
      "COMPASS",
      "CLOCK"
    ],
    "research": [
      "MAP",
      "BOOK"
    ],
    "docs": [
      "QUILL",
      "SIGN"
    ]
  }
}
```

`swarm alloc name` loads these pools and takes the first free name. `planMob` reads `mob_species` and `sprite_items`. `renderSkills` copies the mob and sprite pools into `skills/policy/SKILL.md`.

### `names.spawners`

Type: string[], at least 1, unique, each at least 1 character, required

Default:

```json
[
  "ZAVOD",
  "FABRIKA",
  "KOMBINAT",
  "KOLKHOZ",
  "SOVKHOZ",
  "ARTEL",
  "SHAKHTA",
  "TSEKH",
  "DOMNA",
  "KOTLOVAN",
  "PRORAB",
  "BRIGADIR",
  "MASTER",
  "NARKOM",
  "UDARNIK",
  "TREST",
  "GLAVK",
  "GOSPLAN",
  "NORMA",
  "SMENA",
  "OTDEL",
  "MOLOT",
  "SERP",
  "TRAKTOR",
  "TURBINA",
  "KRAN",
  "STAL",
  "GUDOK",
  "MAGNITKA",
  "URALMASH",
  "ZIL",
  "GAZ",
  "KAMAZ"
]
```

`allocateSpawnerName` and `swarm alloc name spawner` take the first free name in this order.

### `names.secretaries`

Type: string[], at least 1, unique, each at least 1 character, required

Default:

```json
[
  "Peggy",
  "Joan",
  "Dawn",
  "Ida",
  "Allison",
  "Lois",
  "Hildy",
  "Olive",
  "Clara",
  "Margie",
  "Kathy",
  "Jenny",
  "Scarlet",
  "Fran",
  "Betty",
  "Megan",
  "Sally",
  "Trudy",
  "Rachel",
  "Midge",
  "Faye",
  "Shirley",
  "Jane",
  "Bobbie",
  "Suzanne",
  "Sylvia",
  "Mona",
  "Marie",
  "Carla",
  "Diana",
  "Beth",
  "Rebecca",
  "Anna",
  "Joyce",
  "Bethany",
  "Helen",
  "Pima",
  "Anita",
  "Nan",
  "Toni",
  "Gloria"
]
```

`allocateSecretaryName` and `swarm alloc name secretary` take the first free name in this order.

### `names.mob_species`

Type: object, required

Default:

```json
{
  "passive": {
    "audit": [
      "COW",
      "SHEEP",
      "MOOSH",
      "CHICKEN",
      "PIG"
    ],
    "research": [
      "FOX",
      "CAT",
      "OCELOT"
    ],
    "review": [
      "BAT",
      "AXOLOTL",
      "FROG",
      "TURTLE",
      "TADPOLE",
      "PUFFER"
    ],
    "status": [
      "PARROT",
      "RABBIT",
      "SQUID",
      "COD",
      "SALMON"
    ],
    "gather": [
      "ALLAY",
      "DONKEY",
      "MULE",
      "CAMEL",
      "HORSE",
      "SKORSE",
      "ZORSE"
    ],
    "plan": [
      "VILLAGER",
      "SNOWMAN"
    ]
  },
  "neutral": {
    "build": [
      "BEE",
      "DOLPHIN"
    ],
    "fix": [
      "WOLF",
      "POLAR"
    ],
    "refactor": [
      "ENDERMAN",
      "SPIDER"
    ],
    "sync": [
      "GOAT",
      "PIGLIN"
    ],
    "port": [
      "LLAMA"
    ],
    "docs": [
      "PANDA",
      "CAVSPIDR"
    ],
    "ci": [
      "GOLEM",
      "PIGMAN"
    ]
  },
  "hostile": {
    "integrate": [
      "CREEPER",
      "HOGLIN",
      "ZOGLIN",
      "BRUTE"
    ],
    "merge": [
      "GUARDIAN",
      "SHULKER",
      "WITCH"
    ],
    "revert": [
      "SKELETON",
      "STRAY",
      "WITHSKEL"
    ],
    "release": [
      "BLAZE",
      "GHAST",
      "PHANTOM"
    ],
    "raid": [
      "PILLAGER",
      "VINDICTR",
      "EVOKER",
      "VEX"
    ],
    "cleanup": [
      "ZOMBIE",
      "HUSK",
      "DROWNED",
      "ZILLAGER",
      "SILVER",
      "MITE",
      "SLIME",
      "MAGMA"
    ]
  },
  "boss": [
    "DRAGON",
    "WITHER",
    "WARDEN",
    "ELDERG"
  ]
}
```

`allocateMobSpecies` and `planMob` read these pools. `renderSkills` copies each pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive`

Type: object, required

Default:

```json
{
  "audit": [
    "COW",
    "SHEEP",
    "MOOSH",
    "CHICKEN",
    "PIG"
  ],
  "research": [
    "FOX",
    "CAT",
    "OCELOT"
  ],
  "review": [
    "BAT",
    "AXOLOTL",
    "FROG",
    "TURTLE",
    "TADPOLE",
    "PUFFER"
  ],
  "status": [
    "PARROT",
    "RABBIT",
    "SQUID",
    "COD",
    "SALMON"
  ],
  "gather": [
    "ALLAY",
    "DONKEY",
    "MULE",
    "CAMEL",
    "HORSE",
    "SKORSE",
    "ZORSE"
  ],
  "plan": [
    "VILLAGER",
    "SNOWMAN"
  ]
}
```

`allocateMobSpecies` and `planMob` look here for a passive job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.audit`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["COW","SHEEP","MOOSH","CHICKEN","PIG"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the audit job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.research`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["FOX","CAT","OCELOT"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the research job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.review`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["BAT","AXOLOTL","FROG","TURTLE","TADPOLE","PUFFER"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the review job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.status`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["PARROT","RABBIT","SQUID","COD","SALMON"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the status job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.gather`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["ALLAY","DONKEY","MULE","CAMEL","HORSE","SKORSE","ZORSE"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the gather job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.passive.plan`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["VILLAGER","SNOWMAN"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the plan job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral`

Type: object, required

Default:

```json
{
  "build": [
    "BEE",
    "DOLPHIN"
  ],
  "fix": [
    "WOLF",
    "POLAR"
  ],
  "refactor": [
    "ENDERMAN",
    "SPIDER"
  ],
  "sync": [
    "GOAT",
    "PIGLIN"
  ],
  "port": [
    "LLAMA"
  ],
  "docs": [
    "PANDA",
    "CAVSPIDR"
  ],
  "ci": [
    "GOLEM",
    "PIGMAN"
  ]
}
```

`allocateMobSpecies` and `planMob` look here for a neutral job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.build`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["BEE","DOLPHIN"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the build job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.fix`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["WOLF","POLAR"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the fix job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.refactor`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["ENDERMAN","SPIDER"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the refactor job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.sync`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["GOAT","PIGLIN"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the sync job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.port`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["LLAMA"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the port job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.docs`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["PANDA","CAVSPIDR"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the docs job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.neutral.ci`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["GOLEM","PIGMAN"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the ci job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile`

Type: object, required

Default:

```json
{
  "integrate": [
    "CREEPER",
    "HOGLIN",
    "ZOGLIN",
    "BRUTE"
  ],
  "merge": [
    "GUARDIAN",
    "SHULKER",
    "WITCH"
  ],
  "revert": [
    "SKELETON",
    "STRAY",
    "WITHSKEL"
  ],
  "release": [
    "BLAZE",
    "GHAST",
    "PHANTOM"
  ],
  "raid": [
    "PILLAGER",
    "VINDICTR",
    "EVOKER",
    "VEX"
  ],
  "cleanup": [
    "ZOMBIE",
    "HUSK",
    "DROWNED",
    "ZILLAGER",
    "SILVER",
    "MITE",
    "SLIME",
    "MAGMA"
  ]
}
```

`allocateMobSpecies` and `planMob` look here for a hostile job. `renderSkills` copies each pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.integrate`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["CREEPER","HOGLIN","ZOGLIN","BRUTE"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the integrate job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.merge`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["GUARDIAN","SHULKER","WITCH"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the merge job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.revert`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["SKELETON","STRAY","WITHSKEL"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the revert job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.release`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["BLAZE","GHAST","PHANTOM"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the release job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.raid`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["PILLAGER","VINDICTR","EVOKER","VEX"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the raid job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.hostile.cleanup`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["ZOMBIE","HUSK","DROWNED","ZILLAGER","SILVER","MITE","SLIME","MAGMA"]`

`allocateMobSpecies` and `planMob` take the first free name in this pool for the cleanup job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.mob_species.boss`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["DRAGON","WITHER","WARDEN","ELDERG"]`

`allocateMobSpecies` reads this pool for the `boss` job. `renderSkills` copies it into `skills/policy/SKILL.md`.

### `names.sprite_items`

Type: object, required

Default:

```json
{
  "implement": [
    "PICKAXE",
    "AXE",
    "SHOVEL",
    "HOE"
  ],
  "fix": [
    "ANVIL",
    "SHEARS",
    "FLINT"
  ],
  "review": [
    "SWORD",
    "BOW",
    "TRIDENT"
  ],
  "verify": [
    "COMPASS",
    "CLOCK"
  ],
  "research": [
    "MAP",
    "BOOK"
  ],
  "docs": [
    "QUILL",
    "SIGN"
  ]
}
```

`allocateSpriteItem` and `planMob` read these pools. `renderSkills` copies each pool into `skills/policy/SKILL.md`.

### `names.sprite_items.implement`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["PICKAXE","AXE","SHOVEL","HOE"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the implement job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.sprite_items.fix`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["ANVIL","SHEARS","FLINT"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the fix job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.sprite_items.review`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["SWORD","BOW","TRIDENT"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the review job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.sprite_items.verify`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["COMPASS","CLOCK"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the verify job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.sprite_items.research`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["MAP","BOOK"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the research job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `names.sprite_items.docs`

Type: string[], at least 1, unique, each at least 1 character, required

Default: `["QUILL","SIGN"]`

`allocateSpriteItem` and `planMob` take the first free name in this pool for the docs job. `renderSkills` copies the pool into `skills/policy/SKILL.md`.

### `tiers`

Type: object, required

Default: `{"models":{"sprite":{"routes":[{"label":"Cursor Grok","provider":"cursor","model":"cursor-grok-4.6-high"}],"thinking":"medium"}}}`

`swarm sprite routes` reads `tiers.models.sprite.routes`. `renderSkills` reads `tiers.models.sprite.thinking`.

### `tiers.models`

Type: object, required

Default: `{"sprite":{"routes":[{"label":"Cursor Grok","provider":"cursor","model":"cursor-grok-4.6-high"}],"thinking":"medium"}}`

`swarm sprite routes` reads `sprite.routes`. `renderSkills` reads `sprite.thinking`.

### `tiers.models.sprite`

Type: object, required

Default: `{"routes":[{"label":"Cursor Grok","provider":"cursor","model":"cursor-grok-4.6-high"}],"thinking":"medium"}`

`swarm sprite routes` prints `routes`. `renderSkills` writes `thinking` into `skills/mob-creation/SKILL.md`.

### `tiers.models.sprite.routes`

Type: object[], at least 1, required

Default: `[{"label":"Cursor Grok","provider":"cursor","model":"cursor-grok-4.6-high"}]`

`swarm sprite routes` prints this array.

### `tiers.models.sprite.routes[].label`

Type: string, at least 1 character, required

Default: `Cursor Grok`

`swarm sprite routes` includes `label` on each printed route.

### `tiers.models.sprite.routes[].provider`

Type: string, at least 1 character, required

Default: `cursor`

`swarm sprite routes` includes `provider` on each printed route.

### `tiers.models.sprite.routes[].model`

Type: string, at least 1 character, required

Default: `cursor-grok-4.6-high`

`swarm sprite routes` includes `model` on each printed route.

### `tiers.models.sprite.thinking`

Type: string, required

Default: `medium`

`renderSkills` writes this into `skills/mob-creation/SKILL.md`.

### `mail`

Type: object, required

Default: `{"classes":["sec.push","sec.retry","sec.retire","sec.log","spawner.dispatch","spawner.decide","core.escalate","policy"],"digest_minutes":30}`

`createShadow` reads the built-in `classes` and `digest_minutes` when its options omit them. `replay` and `readFileMail` read the built-in class list.

### `mail.classes`

Type: string[], required

Default: `["sec.push","sec.retry","sec.retire","sec.log","spawner.dispatch","spawner.decide","core.escalate","policy"]`

`createShadow` uses the built-in class list when its options omit `classes`. `replay` draws synthetic classes from that list. `readFileMail` uses it when the caller omits classes.

### `mail.digest_minutes`

Type: integer, minimum 1, required

Default: `30`

`createShadow` uses the built-in digest interval, in minutes, when its options omit `digest_minutes`.

### `secretary`

Type: object, required

Default:

```json
{
  "questions": {
    "intake_route": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "needs_spawner": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "can_wait": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "urgency_match": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "report_clean": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "duplicate": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "still_relevant": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "handler": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "outcomes_complete": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    },
    "finding_blocks_invariant": {
      "enabled": false,
      "prompt_version": 1,
      "threshold": 0.97,
      "late_p1_rate_limit": "1/500",
      "state": "shadow"
    }
  }
}
```

`createClassifier` reads `secretary.questions` from the loaded tree.

### `secretary.questions`

Type: map, key matching `^(?!(?:__proto__|constructor)$)`, required

Default:

```json
{
  "intake_route": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "needs_spawner": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "can_wait": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "urgency_match": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "report_clean": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "duplicate": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "still_relevant": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "handler": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "outcomes_complete": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  },
  "finding_blocks_invariant": {
    "enabled": false,
    "prompt_version": 1,
    "threshold": 0.97,
    "late_p1_rate_limit": "1/500",
    "state": "shadow"
  }
}
```

`createClassifier` reads this map and looks up `intake_route`, `needs_spawner`, `can_wait`, `urgency_match`, `report_clean`, `duplicate`, `still_relevant`, `handler`, `outcomes_complete`, `finding_blocks_invariant`.

### `secretary.questions.*`

Type: object

Default: `{"enabled":false,"prompt_version":1,"threshold":0.97,"late_p1_rate_limit":"1/500","state":"shadow"}` on each entry

`createClassifier` reads these fields for a question it knows.

### `secretary.questions.*.enabled`

Type: boolean, required

Default: `false` on each entry

`createClassifier` wakes with reason `disabled` when this is false.

### `secretary.questions.*.prompt_version`

Type: integer, minimum 1, required

Default: `1` on each entry

`createClassifier` wakes with reason `invalid` unless this is `1`.

### `secretary.questions.*.threshold`

Type: number, minimum 0, maximum 1, required

Default: `0.97` on each entry

`createClassifier` records reason `below_threshold` when the answer probability is below this.

### `secretary.questions.*.late_p1_rate_limit`

Type: string, required

Default: `1/500` on each entry

`createClassifier` parses this as a costly-mistake limit and latches the question to `shadow` after a breach.

### `secretary.questions.*.state`

Type: `shadow` | `live`, required

Default: `shadow` on each entry

`createClassifier` applies an answer only while the effective state is `live`. `shadow` wakes instead.

### `claims`

Type: object, required

Default: `{"hours":4,"pause_on_downtime":false,"reclaim_cooldown_minutes":15,"open_claims_per_repo":2,"uncommitted_claims_per_repo":1,"dock":{"missed_claim":1}}`

`createClaimRule` and `dockMisses` read the claims config they are given. `renderSkills` writes `hours` and `reclaim_cooldown_minutes` into `skills/policy/SKILL.md`. `scoreRules` reads `dock.missed_claim`.

### `claims.hours`

Type: integer, minimum 1, required

Default: `4`

`renderSkills` writes this into `skills/policy/SKILL.md` as the claim hard cutoff, in hours.

### `claims.pause_on_downtime`

Type: boolean, required

Default: `false`

`createClaimRule` refuses to install a claim rule when this is true.

### `claims.reclaim_cooldown_minutes`

Type: integer, minimum 0, required

Default: `15`

`dockMisses` adds this many minutes to the cooldown. `renderSkills` writes it into `skills/policy/SKILL.md`. `createClaimRule` enforces the cooldown already recorded.

### `claims.open_claims_per_repo`

Type: integer, minimum 0, required

Default: `2`

`createClaimRule` refuses another claim when open claims reach this cap.

### `claims.uncommitted_claims_per_repo`

Type: integer, minimum 0, required

Default: `1`

`createClaimRule` refuses another claim when uncommitted claims reach this cap.

### `claims.dock`

Type: object, required

Default: `{"missed_claim":1}`

`dockMisses` and `scoreRules` read `missed_claim`.

### `claims.dock.missed_claim`

Type: integer, minimum 0, required

Default: `1`

`dockMisses` records this many points for a missed claim. `scoreRules` multiplies `score.missed_claim` by it.

### `review`

Type: object, required

Default: `{"docs_only":{"model_review":false},"code":{"review_rounds":1,"fix_rounds":1}}`

`renderSkills` writes the three leaves below into `skills/policy/SKILL.md`.

### `review.docs_only`

Type: object, required

Default: `{"model_review":false}`

`renderSkills` reads `model_review`.

### `review.docs_only.model_review`

Type: boolean, required

Default: `false`

`renderSkills` writes this into `skills/policy/SKILL.md`.

### `review.code`

Type: object, required

Default: `{"review_rounds":1,"fix_rounds":1}`

`renderSkills` reads `review_rounds` and `fix_rounds`.

### `review.code.review_rounds`

Type: integer, minimum 0, required

Default: `1`

`renderSkills` writes this into `skills/policy/SKILL.md`.

### `review.code.fix_rounds`

Type: integer, minimum 0, required

Default: `1`

`renderSkills` writes this into `skills/policy/SKILL.md`.

### `score`

Type: object, required

Default:

```json
{
  "state": "off",
  "merged_work": 10,
  "stays_merged_days": 7,
  "revert": 10,
  "review_round": 1,
  "free_review_rounds": 1,
  "tokens_per_merged_pr": {
    "target": 500000,
    "tokens_per_point": 100000,
    "max_penalty": 5
  },
  "human_minutes": {
    "per_point": 15,
    "max_penalty": 10
  },
  "missed_claim": 5,
  "unknown_spend": 2,
  "levels": [
    {
      "name": "1",
      "min": 0
    },
    {
      "name": "2",
      "min": 20
    },
    {
      "name": "3",
      "min": 60
    },
    {
      "name": "4",
      "min": 150
    },
    {
      "name": "5",
      "min": 400
    }
  ],
  "milestones": [
    {
      "id": "first-stable-merge",
      "metric": "stable_merges",
      "at": 1
    },
    {
      "id": "ten-stable-merges",
      "metric": "stable_merges",
      "at": 10
    },
    {
      "id": "first-fully-reported-merge",
      "metric": "fully_reported_merges",
      "at": 1
    }
  ]
}
```

`scoreRules` copies this object from the loaded tree. `swarm score` loads that tree from `--rules`, or the built-in defaults when `--rules` is omitted. `scoreParty` applies the copied rules.

### `score.state`

Type: `off` | `shadow` | `on`, required

Default: `off`

`scoreRules` copies this onto the rules. `scoreParty` and `swarm score` include it on the scorecard.

### `score.merged_work`

Type: integer, minimum 0, maximum 1000000, required

Default: `10`

`scoreParty` adds this many points for a stable verified merge.

### `score.stays_merged_days`

Type: integer, minimum 0, maximum 1000000, required

Default: `7`

`scoreParty` waits this many days after a merge before it counts as stable.

### `score.revert`

Type: integer, minimum 0, maximum 1000000, required

Default: `10`

`scoreParty` removes this many points when that work was reverted.

### `score.review_round`

Type: integer, minimum 0, maximum 1000000, required

Default: `1`

`scoreParty` removes this many points for each review round after the free rounds.

### `score.free_review_rounds`

Type: integer, minimum 0, maximum 1000000, required

Default: `1`

`scoreParty` leaves this many review rounds with no penalty.

### `score.tokens_per_merged_pr`

Type: object, required

Default: `{"target":500000,"tokens_per_point":100000,"max_penalty":5}`

`scoreParty` uses this object for the token penalty on a stable merge.

### `score.tokens_per_merged_pr.target`

Type: integer, minimum 0, maximum 1000000000000, required

Default: `500000`

`scoreParty` counts tokens above this target toward the penalty.

### `score.tokens_per_merged_pr.tokens_per_point`

Type: integer, minimum 1, maximum 1000000000000, required

Default: `100000`

`scoreParty` charges one penalty point per this many tokens over the target.

### `score.tokens_per_merged_pr.max_penalty`

Type: integer, minimum 0, maximum 1000000, required

Default: `5`

`scoreParty` caps the token penalty at this many points. Unknown spend on the merge uses the cap.

### `score.human_minutes`

Type: object, required

Default: `{"per_point":15,"max_penalty":10}`

`scoreParty` uses this object for the human-minutes penalty.

### `score.human_minutes.per_point`

Type: integer, minimum 1, maximum 1000000, required

Default: `15`

`scoreParty` charges one penalty point per this many human minutes.

### `score.human_minutes.max_penalty`

Type: integer, minimum 0, maximum 1000000, required

Default: `10`

`scoreParty` caps the human-minutes penalty at this many points. A minutes fact with no count uses the cap.

### `score.missed_claim`

Type: integer, minimum 0, maximum 1000000, required

Default: `5`

`scoreParty` removes this many points per missed claim, after `scoreRules` multiplies it by `claims.dock.missed_claim`.

### `score.unknown_spend`

Type: integer, minimum 1, maximum 1000000, required

Default: `2`

`scoreParty` removes this many points for each unknown spend item.

### `score.levels`

Type: object[], at least 1, required

Default: `[{"name":"1","min":0},{"name":"2","min":20},{"name":"3","min":60},{"name":"4","min":150},{"name":"5","min":400}]`

`levelFor` picks the last level whose `min` is less than or equal to the total.

### `score.levels[].name`

Type: string, required

Default:

```json
[
  "1",
  "2",
  "3",
  "4",
  "5"
]
```

`levelFor` returns this name on the chosen level.

### `score.levels[].min`

Type: integer, minimum -1000000000, maximum 1000000000, required

Default:

```json
[
  0,
  20,
  60,
  150,
  400
]
```

`levelFor` compares the total with this minimum. `scoreRules` requires each minimum to be greater than the previous one.

### `score.milestones`

Type: object[], required

Default:

```json
[
  {
    "id": "first-stable-merge",
    "metric": "stable_merges",
    "at": 1
  },
  {
    "id": "ten-stable-merges",
    "metric": "stable_merges",
    "at": 10
  },
  {
    "id": "first-fully-reported-merge",
    "metric": "fully_reported_merges",
    "at": 1
  }
]
```

`milestonesFor` marks each milestone reached or unmet.

### `score.milestones[].id`

Type: string, required

Default:

```json
[
  "first-stable-merge",
  "ten-stable-merges",
  "first-fully-reported-merge"
]
```

`milestonesFor` copies this id onto the scorecard. `scoreRules` rejects a duplicate id.

### `score.milestones[].metric`

Type: `stable_merges` | `fully_reported_merges`, required

Default:

```json
[
  "stable_merges",
  "stable_merges",
  "fully_reported_merges"
]
```

`milestonesFor` counts stable merges for `stable_merges`, and stable merges with reported spend for `fully_reported_merges`.

### `score.milestones[].at`

Type: integer, minimum 1, required

Default:

```json
[
  1,
  10,
  1
]
```

`milestonesFor` reaches the milestone at this many matching merges.

### `setup`

Type: object, required

Default: `{"environment":"politburo"}`

`renderSkills` writes `environment` into `skills/mob-creation/SKILL.md`.

### `setup.environment`

Type: string, required

Default: `politburo`

`renderSkills` writes this into `skills/mob-creation/SKILL.md` as the cloud environment name.

### `trackers`

Type: map, key matching `^(?!(?:__proto__|constructor)$)`, required

Default: `{}`

`swarm trackers scan` reads `sources` and `precedence` for the repo key you name.

### `trackers.*`

Type: object

Default: none

`swarm trackers scan` reads this entry when the repo argument matches the key.

### `trackers.*.sources`

Type: string[], required

Default: none

`swarm trackers scan` opens these source ids.

### `trackers.*.precedence`

Type: string[], required

Default: none

`swarm trackers scan` merges items in this order.

## Example

This party layer merges over the built-in defaults.

```yaml
party:
  id: workshop
  name: Workshop
  colour: "#245c3d"
claims:
  hours: 2
  open_claims_per_repo: 1
mail:
  digest_minutes: 15
review:
  docs_only:
    model_review: true
score:
  state: shadow
secretary:
  questions:
    can_wait:
      enabled: false
      prompt_version: 1
      threshold: 0.97
      late_p1_rate_limit: "1/500"
      state: shadow
trackers:
  acme/web:
    sources:
      - github:acme/web
    precedence:
      - github:acme/web
```

`swarm config validate --party` on this layer prints `valid`.
