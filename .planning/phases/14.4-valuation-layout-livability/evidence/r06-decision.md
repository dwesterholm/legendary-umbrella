# R-06 decision: read the remaining sold pages?

Beslut: ingen utökning

No more sold pages are read. Both new coefficients are clearly away from zero on the 1 200 rows already read, so reading the other ≈ 4 500 sales would shrink the error bars but change no decision. Cost of this decision: 0 pages, 0 USD.

## The rule (R-06)

Read the rest only if the raw t-value of avgift or BRF debt is below 2 in absolute value, and only if the 1 200-row run was clean (under 5 % failed pages, no Booli challenge page). "Raw" means the first fit, before the sign and stability guard could replace anything. A coefficient the guard zeroes for a wrong sign far from zero is not a reason to read more.

## The numbers (evidence/fit-14.4.log)

| | Avgift kr/kvm/mån | Föreningsskuld kr/kvm |
|---|---|---|
| Sales with the value | 1 192 of 7 430 (1 185 after outlier removal) | 1 014 of 7 430 (1 007 after), in 649 associations |
| Raw coefficient (ln price per unit) | -0,000644 | -0,00000239 |
| Standard error | 0,000197 | 0,000000827 |
| Raw t | -3,3 | -2,9 |
| Used by the model | the raw value (guard left it alone) | the raw value (guard left it alone) |
| Effect on kr/kvm | -0,64 % per 10 kr/kvm/mån | -0,24 % per 1 000 kr/kvm |

Both |t| are above 2, so the rule does not trigger.

## Two checks on the t-values

The standard errors assume each sale is independent. Avgift is per flat, so that holds. Flats in the same association share one debt figure, and 1 014 flats sit in 649 associations (1,56 flats each). If every flat in an association had the identical error, the debt standard error would grow by √1,56 ≈ 1,25 and t would be about -2,3. That is the worst case and it is still above 2.

The two features overlap only a little. Their correlation is 0,34 over 1 009 sales that have both, and the variance inflation (how much overlap widens an error bar) is 1,26 for avgift and 1,18 for debt.

## What was not decided here

Tomträtt has no variation to test (1 155 sold pages, all "Bostadsrätt"), so reading more Bostadsrätt pages cannot give it a coefficient. It stays zeroed, with the reason "absent" in the model file.

The 1 200-row run itself was clean (0 failed pages, 0 challenge pages, 2 pages without a sold payload), so that condition was met as well. It would only have mattered for an extension.
