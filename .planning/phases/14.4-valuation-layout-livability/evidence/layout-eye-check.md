# Layout read, by-eye check of 12 flats (Phase 14.4 plan 08, LAY-04, D-11)

Date: 2026-10-13. Done by the executor (Daniel does not test by hand). Sample: the 12 flats with a stored layout and the lowest Booli ids in the live run (`layout-coverage.json`, `eyeSample`). For each flat I downloaded the first four Booli pictures (the ones the layout read saw; https bcdn.se only, into a temporary directory, deleted afterwards, nothing kept or committed), opened them and read the floor plan and the photos myself.

What I could and could not see: the Booli pictures only. The broker photos the read also saw (up to 3 per flat, in memory only) I did not see. Street versus courtyard cannot be proven from a floor plan; I only judge it where a photo shows cars, a road or a courtyard with paving and greenery, and otherwise write "går inte att avgöra". The "Modellens läsning" column is the raw answer before the 0,6 gate; "efter spärren" says what the gate let through.

Verdict words: stämmer / stämmer inte / går inte att avgöra.

| Booli id | Modellens läsning (balkong / fönster / sovrum, säkerhet) | Efter spärren | Min läsning och dom per fält | Anteckning |
|---|---|---|---|---|
| 130457 | courtyard / one / courtyard, 0,60 | balkong gård, korsdrag nej, sovrum gård | balkongsida: går inte att avgöra; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Plan: balcony, living room and bedroom windows all on the right wall, so one side is right. Photos show roofs and a brick neighbour at some distance, no road or courtyard floor, so street versus courtyard stays open. |
| 142942 | none / twoOpposite / unknown, 0,60 | balkong ingen, korsdrag ja, sovrum okänd | balkongsida: stämmer; fönstersidor: stämmer inte; sovrumssida: går inte att avgöra | Plan has windows only on the left wall (kitchen, living room, sleeping alcove). No window on the opposite side. The read says two opposite sides, so a wrong "korsdrag ja" got through the gate at exactly 0,60. |
| 144070 | courtyard / one / unknown, 0,70 | balkong gård, korsdrag nej, sovrum okänd | balkongsida: stämmer; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Balcony photo looks down on a paved courtyard with trees and planters, so courtyard is right. Plan puts the bedroom window on the same left wall as the balcony (the read said the bedroom is not on the balcony side, which stämmer inte, but that field is not used downstream). Bedroom side unknown at the gate. |
| 150148 | courtyard / one / courtyard, 0,55 | allt okänd (under 0,6) | balkongsida: stämmer inte; fönstersidor: stämmer; sovrumssida: stämmer inte | Folkungagatan 61. Known truth (D-11) is street for balcony and bedroom. The "courtyardGreenery" evidence is most likely the artificial grass on the balcony floor. Plan: balcony door and bedroom window on the same bottom wall, so one side is right. The gate blocked the wrong sides at 0,55. |
| 208640 | none / one / unknown, 0,40 | allt okänd (under 0,6) | balkongsida: stämmer; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Three plans (original and two alternatives) and one kitchen photo. No balcony drawn, windows only on the top wall. Correctly low confidence. |
| 309602 | courtyard / corner / unknown, 0,70 | balkong gård, korsdrag nej, sovrum okänd | balkongsida: går inte att avgöra; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Balcony off the kitchen, windows on the top and right sides, none opposite. Balcony photo shows a large chestnut tree and buildings behind it, no road and no courtyard floor; a street tree is as likely as a courtyard tree. |
| 315823 | none / one / unknown, 0,55 | allt okänd (under 0,6) | balkongsida: går inte att avgöra; fönstersidor: går inte att avgöra; sovrumssida: går inte att avgöra | No floor plan among the four Booli pictures (image 1 is a living room photo), so the premise "image 1 is the plan" did not hold. One photo does show a street with a parked car from a high floor. |
| 323721 | courtyard / twoOpposite / unknown, 0,70 | balkong gård, korsdrag ja, sovrum okänd | balkongsida: går inte att avgöra; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Long flat, living room window and balcony at the left end, bedroom window at the right end: two opposite sides is right. Balcony photo faces a facade with balconies across an open gap and a tree, no road visible; consistent with a courtyard but not proof. The evidence word "oppositeFacade" is present on both street and courtyard sides. |
| 324812 | none / twoOpposite / unknown, 0,70 | balkong ingen, korsdrag ja, sovrum okänd | balkongsida: stämmer; fönstersidor: stämmer inte; sovrumssida: går inte att avgöra | Plan has windows only on the left wall. The "fönster" on the plan and the high panes in the photos sit between the living room and the sleeping alcove (inside glass). A wrong "korsdrag ja" at 0,70 got through the gate. |
| 324847 | none / one / unknown, 0,55 | allt okänd (under 0,6) | balkongsida: stämmer; fönstersidor: stämmer inte; sovrumssida: går inte att avgöra | Long flat with a kitchen window at the left end and a living room window at the right end: two opposite sides is the truth, the read said one. Gated out at 0,55, so no taste was lost or wrongly given. |
| 324863 | none / one / unknown, 0,40 | allt okänd (under 0,6) | balkongsida: stämmer; fönstersidor: stämmer; sovrumssida: går inte att avgöra | All four pictures are plans (no photos), evidence none, confidence 0,40. All windows on the top wall. Honest low confidence. |
| 328402 | none / corner / unknown, 0,60 | balkong ingen, korsdrag nej, sovrum okänd | balkongsida: stämmer; fönstersidor: stämmer; sovrumssida: går inte att avgöra | Windows are on the left wall only (bay-shaped), so "corner" is not exact but "no korsdrag" is right, which is what is used downstream. |

## Totals per field (12 flats)

| Fält | stämmer | stämmer inte | går inte att avgöra |
|---|---|---|---|
| balkongsida | 7 | 1 (150148) | 4 |
| fönstersidor | 8 | 3 (142942, 324812, 324847) | 1 |
| sovrumssida | 0 | 1 (150148) | 11 |

Reading of the totals:

- Balcony yes or no (none versus a balcony) agreed with Booli's own balcony flag in 12 of 12 of these flats. Street versus courtyard could be confirmed in 1 flat (144070), refuted in 1 (150148), and left open in 4 because the photos show neither a road nor a courtyard floor.
- Korsdrag: the gate let through "ja" for three of the twelve (142942, 323721, 324812). One is right, two are wrong, both wrong ones at confidence 0,60 and 0,70. "Nej" was let through for four (130457, 144070, 309602, 328402) and all four are right.
- A third wrong window answer (324847, "one" where the plan has windows at both ends) was stopped by the gate at 0,55.
- Sovrumssida: only 130457 had a usable bedroom answer here (courtyard) and I could not confirm it; the others are unknown after the gate.
- Folkungagatan 61 again read courtyard for balcony and bedroom; the gate (0,55) kept it out of the table and out of taste.
- In 1 of 12 flats (315823) there was no floor plan among the first four Booli pictures; the prompt's assumption that picture 1 is the plan does not always hold.
