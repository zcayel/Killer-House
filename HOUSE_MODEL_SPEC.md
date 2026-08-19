# House model replacement spec

Build to this and swapping the new house in costs nothing — no code changes, no
recalibration. Miss it and roughly 52 hardcoded world coordinates in
`src/config.ts` have to be re-derived by hand.

Everything below was measured directly out of `HLtemplate.glb` and
`assets/scene/main.composite`, not estimated.

---

## 1. The one rule that matters

**Keep the origin and the three floor planes exactly where they are.**

The house is placed as composite entity `513`, name `Template`:

| | |
|---|---|
| Position | `(23.0234, 11.6738, 16.25)` |
| Scale | `1, 1, 1` |
| Rotation | identity |

That position never changes. So the model's own origin must stay where it is
relative to the geometry, and everything below is quoted **both** in world
space (what the game code uses) and in **model-local space** (what you'll see
in Blender, = world − origin).

Easiest way to guarantee this: **import the existing `HLtemplate.glb` into
Blender as a reference layer, build the new house around it, delete the
reference before export.** Do not re-origin, do not "apply transforms" in a way
that moves the origin, do not let Blender's glTF exporter add a +Y-up
conversion on top of what's already baked in.

---

## 2. Floor planes — non-negotiable

Three walkable planes. The game snaps blood stains to them, decides which area
you've reached from them, and places every candle and trap against them.

| Floor | World Y | Model-local Y |
|---|---|---|
| Upper floor | **8.4** | −3.2738 |
| Ground floor | **2.58** | −9.0938 |
| Yard (outside) | **0** | −11.6738 |

Code that breaks if these move: `FLOOR_LEVELS_Y`, `areaIndexForY()` (its y≥6 /
y≥2 bands), every candle Y, every trap Y, the chandelier ride, the spike
torso-height assumption.

---

## 3. Footprint and walls

| Feature | World | Model-local |
|---|---|---|
| Exterior footprint X | 13.2 → 31.2 | −9.8234 → 8.1766 |
| Exterior footprint Z | 8.4 → 22.0 | −7.85 → 5.75 |
| East interior wall | x ≈ 30.3 | x ≈ 7.2766 |
| West interior wall | x ≈ 14.0 | x ≈ −9.0234 |
| South interior wall | z ≈ 9.1 | z ≈ −7.15 |
| North interior wall | z ≈ 21.2 | z ≈ 4.95 |

`HOUSE_RECT` in config is the exterior footprint; the wall planes are where the
spike units hide. Roof and overhangs may exceed the footprint — the current
model reaches x 34.56, which is fine.

**Parcel budget:** 16 parcels (4×4) = 64×64 m, height cap ~82 m. Current house
is 20.1 × 24.6 × 22.4 and tops out at world y 24.5. You have plenty of room.

---

## 4. Openings that must stay open

Two door props are placed as separate entities and will not move with the
house. Leave doorways where they are:

| | World | Model-local |
|---|---|---|
| Front door | `(28.31, 2.51, 9.07)` | `(5.2866, −9.1638, −7.18)` |
| Back door | `(26.93, 2.59, 21.20)` | `(3.9066, −9.0838, 4.95)` |

The front door is the player's first sight of the house — spawn is at
`(27, 0.1, 1)` looking 8° toward `(28, 3, 8)`.

**Chandelier lift shaft** — `chandelift.glb`, entity `512` "Vertical Red Pad",
at `(27.68, 3.18, 11.66)`, rides from y 3.18 up to 13.18. That vertical shaft
must stay clear from the ground floor through to the upper floor.

- Model-local: x `4.6566`, z `−4.59`, travelling y `−8.4938` → `1.5062`

---

## 5. Surfaces the candles stand on

13 candle spots, verified once by raycasting against this model's own
`_collider` mesh in Blender (every one confirmed ≥0.79 m clear of any surface).
**If the interior changes, that verification has to be re-run** — it is a
one-time offline check, not something the game re-validates at runtime.

Interior spots (world → model-local):

| World | Model-local | Note |
|---|---|---|
| `(18.5, 4.04, 19.0)` | `(−4.5234, −7.6338, 2.75)` | **guaranteed** — always drawn |
| `(27.59, 2.73, 16.45)` | `(4.5666, −8.9438, 0.2)` | **guaranteed** — see warning below |
| `(14.6, 2.7, 21.3)` | `(−8.4234, −8.9738, 5.05)` | west room |
| `(26.0, 2.68, 9.2)` | `(2.9766, −8.9938, −7.05)` | front-door area |
| `(25.8, 2.68, 20.9)` | `(2.7766, −8.9938, 4.65)` | by the back door |
| `(26.8, 2.58, 14)` | `(3.7766, −9.0938, −2.25)` | just outside the spike lane |
| `(18.5, 2.58, 16.2)` | `(−4.5234, −9.0938, −0.05)` | beside the carpet |
| `(16.9, 8.5, 17.3)` | `(−6.1234, −3.1738, 1.05)` | upstairs |
| `(20.9, 8.5, 20.0)` | `(−2.1234, −3.1738, 3.75)` | upstairs far corner |
| `(19, 8.4, 17.5)` | `(−4.0234, −3.2738, 1.25)` | upstairs |

The other 4 are in the yard and don't depend on the house at all.

⚠️ `(27.59, 2.73, 16.45)` is already flagged in config as risky — it's
`guaranteed` *and* sits only ~0.2 m outside a wall spike's trigger radius
during a 3.5 s stationary channel. If you're reshaping that corner, move it
somewhere with real margin.

---

## 6. Interior props that stay put

These are **separate entities** that will not move or scale with the new house.
Build the interior so they still land correctly, or tell me and I'll reposition
them:

| Prop | World position |
|---|---|
| `carpet` (pressure-plate dart trap) | `(19.25, 2.58, 17.75)` |
| `carpet_2` | `(27.75, 2.58, 15.50)` |
| `oldtable` | `(18.00, 3.21, 18.18)` |
| `wallshelf` | `(14.09, 4.75, 17.85)` |
| `pblade.glb` (swinging blade trap) | `(18.60, 3.20, 16.19)` |
| `Skull` | `(18.87, 3.91, 18.25)` |
| `butchersknife` | `(13.99, 5.03, 17.87)` |
| `Long Opened Wooden Crate` | `(17.28, 8.40, 19.74)` |
| `Soccer Ball_3` | `(16.84, 8.32, 16.82)` |
| 3 × ambient sound emitters | y 7.5–8.82, around x 16.3–16.5 |

Wall spike units live inside the four interior walls at torso height
(y 3.5), thrusting into the room — see `WALL_SPIKE_UNITS` in config.

---

## 7. Export requirements

**Colliders — the most important technical item.** The current model ships two
meshes:

| Node | Mesh | Role |
|---|---|---|
| `TemplateHN` | `Cube.5352` | visible geometry |
| `TemplateHN_collider` | `Cube.874` | invisible collision proxy |

The visible mesh carries **zero collision**. Everything the player stands on,
walks into, or gets raycast against comes from the `_collider` mesh. **If you
export without a mesh whose name ends in `_collider`, players fall straight
through the floor.**

Keep the collider watertight if you can — the existing one isn't, which is why
the candle verification had to fall back to nearest-surface distance instead of
inside/outside parity testing.

**Everything else:**

| | Current | Target |
|---|---|---|
| Triangles | ~9,286 | ≤ ~15,000 (mobile) |
| Materials | 11 | keep low |
| Textures | 17, **embedded** | keep embedded — no external URIs |
| File size | 2.28 MB | ≤ ~4 MB |
| Format | `.glb` | `.glb` |

The two loose `.jpg` files in the model folder (`m011_base.jpg`,
`tileb_base.jpg`) are leftover source art — nothing loads them.

---

## 8. Worth adding while you're in there

**Stairs.** This is the single highest-value change available. The Week 2
feedback says the route upstairs must not depend on precise jumping, because V1
has to work on mobile — and right now the chandelier lift is the only way up,
and it also kills people. A real staircase from the ground floor (y 2.58) to
the upper floor (y 8.4) closes the biggest open item in the whole project.

**Sightline from the front door to the first candle.** Feedback says players
must see their first objective on entry. A clear line from `(28.31, 2.51, 9.07)`
to the `(26.0, 2.68, 9.2)` candle spot would do it.

**Don't add rooms.** The feedback doc's section 8 is explicit: no expansion
until players can follow one complete route through the existing space.

---

## 9. Handing it over

Drop the new `.glb` in and tell me. Either:

- **Same path** — overwrite `assets/scene/Models/HLtemplate/HLtemplate.glb`.
  Nothing in the composite or the code changes at all.
- **New file** — put it anywhere under `assets/scene/Models/` and I'll update
  entity `513`'s `GltfContainer.src`.

Then I will:

1. Measure the new model the same way I measured this one (GLB accessor bounds
   + full node TRS) and verify the floor planes and footprint actually landed
   where they should.
2. Re-run the candle-spot clearance check against the new `_collider` mesh.
3. Report anything that drifted, with the corrected constants.

Note: `main.crdt` is what actually ships and what the runtime reads —
`main.composite` is Creator Hub's editor format. If the composite needs
changing, **open and save the project in Creator Hub** so the `.crdt`
regenerates. Config line 572 already records this drift biting once before.
