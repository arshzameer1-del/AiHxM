# Reports & Analytics: visualization guide

The web app has no chart library, so the charts are small hand-built SVG and HTML components in `apps/web/src/portal/reports/charts.tsx`. They follow the rules below, which any new chart must keep.

## Which chart for which question

| Question | Chart | Notes |
|---|---|---|
| One headline number | KPI card | Value, unit, and a one-line note naming the period or the denominator. A missing value is a dash, never a zero. |
| How much, by group | Horizontal bar | Long names stay readable. Grouped when there are several series. |
| How a total splits | Donut | At most 8 slices; the smallest fold into "Other". Never a ninth colour. |
| Change over time | Line | One scale from zero, endpoint emphasised, hover and keyboard readout. |
| Parts of a total, by group | Stacked bar | A 2px gap between segments; the total is written beside the bar. |
| Exact figures, many columns | Table | Every report has one; sortable; 50 rows at a time with "show more". |

Heatmaps and funnels are not used: no report in this release needs them, and none is drawn without one that does.

## Rules every chart keeps

1. **One scale.** Marks, ticks and labels come from the same scale, which starts at zero. No dual axis: two measures of different size are two charts.
2. **Not colour alone.** Every chart has a legend or direct values; donuts list label, value and percentage beside the ring.
3. **Colour follows the series, not its rank.** Series colours are assigned by position from a fixed list (`SERIES_COLORS`) and are never cycled. Status colours (green, amber, red) are reserved for status.
4. **Accessible.** Each chart is a `figure` with a caption and a screen-reader summary (title, unit, highest and lowest points). Marks are keyboard-focusable and carry a full label. A "Show as table" button swaps in a table with exactly the same numbers.
5. **Honest empty states.** A chart with no data is not drawn; the page says what is missing ("No records match these filters"). Notes from the report ("12 employees have no department") are shown in a "Read with care" box.
6. **Tooltips** on hover and focus name the group, the series and the value with its unit.
7. **Thin marks, quiet grid.** Light grid, zero line slightly stronger, no gradients, no 3D.

## The result a report returns

A chart is described by data, not drawn by the server: `{ kind, title, unit, xKey, series[], data[] }`. KPI units are `count`, `percent`, `days` and `hours`; a delta is shown signed and in the same unit. Adding a chart kind means adding it to the shared type, the renderer and `reportFormat.ts` in the same change.

## Tested

`reportFormat.test.ts` (units, deltas, cells, filter chips, chart summaries), `reportCatalogView.test.ts` (search, status, favourites, recent) and `Reports.e2e.spec.ts` (library, search, run, blocked state, unknown id, role visibility against the real API).
