# Albion Flipper TODOs

- [ ] **PRIORITY:** Define the player terms in `item-terms.json` for equipment bases and their set/artifact variants (for example, `ARMOR_LEATHER` → “Jacket”, then `SET1` → “Mercenary”).
- [x] **PRIORITY:** Show the dictionary-derived player name beside each raw item ID in the main flip tables. Keep tier, set, and artifact variants clear at a glance.
- [ ] Verify the dictionary recognizes scanned equipment across head, bags, armors, foot armors, main weapons, 2-handed weapons, off hands, and capes; surface any unrecognized equipment IDs for mapping.
- [x] Show combined rune, soul, and relic requirements for active saved enchantment routes.
- [x] Compare saved-flip stone demand with scanned stock and flag stock or price shortfalls for manual review. (Initial version; refine reservation and risk calculations later.)
- [ ] Show stone scan ages so it is clear when rune, soul, and relic prices or quantities need to be rescanned. Account for stones that may have been consumed since the last scan.
- [ ] Add database schema setup and migrations to the repository so the database can be initialized on Linux.
- [ ] Prepare and document a Linux setup for the main laptop.
