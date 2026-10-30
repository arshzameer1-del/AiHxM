// Custom module icons, drawn for AiHxM (48x48, stroke style). Each one has a small, purposeful motion that matches what the
// module does (a clock hand moves, bars grow, a candidate enters a pipeline). The motion classes (ia-*) live in styles.css,
// run once when the icon's section scrolls into view and again on hover, and are switched off for reduced-motion users.
const d = (i) => ` style="--d:${(i * 0.12).toFixed(2)}s"`;
const wrap = (inner) => `<svg class="ico" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

const ICONS = {
  // Employee profile appears
  "core-hr": () => wrap(`<rect x="7" y="9" width="34" height="30" rx="5"/><g class="ia-pop"${d(0)}><circle cx="19" cy="21" r="4.5"/><path d="M11.5 33c1-4.2 4-6 7.5-6s6.5 1.8 7.5 6"/></g><path class="ia-draw" pathLength="1"${d(2)} d="M31 20h6M31 26h6M31 32h4"/>`),
  // Calendar date selection
  leave: () => wrap(`<rect x="7" y="10" width="34" height="30" rx="5"/><path d="M7 19h34M16 6v7M32 6v7"/><circle class="ia-pulse" cx="19" cy="29" r="3.6" fill="currentColor" stroke="none"${d(1)}/><path d="M28 29h6M13 34h2M23 34h2M30 34h5" opacity=".55"/>`),
  // Clock hands move
  attendance: () => wrap(`<circle cx="24" cy="25" r="16"/><path d="M24 6v3M41 25h-3M24 44v-3M7 25h3" opacity=".6"/><g class="ia-spin"><path d="M24 25V14"/></g><g class="ia-spin slow"><path d="M24 25l7 4"/></g><circle cx="24" cy="25" r="1.8" fill="currentColor" stroke="none"/>`),
  // Salary document animation
  payroll: () => wrap(`<path d="M12 6h18l8 8v28H12z"/><path d="M30 6v8h8"/><path class="ia-draw" pathLength="1"${d(1)} d="M18 22h14M18 28h10"/><g class="ia-coin"><circle cx="31" cy="35" r="6" fill="var(--ico-fill,#fff)"/><path d="M31 32v6M29 34h3a1.4 1.4 0 010 2.8h-2.6" stroke-width="1.6"/></g>`),
  // Connected process nodes
  workflow: () => wrap(`<circle cx="9" cy="14" r="4.5"/><circle cx="24" cy="34" r="4.5"/><circle cx="39" cy="14" r="4.5"/><path class="ia-draw" pathLength="1" d="M13 17l8 14"/><path class="ia-draw" pathLength="1"${d(2)} d="M27 31l8-14"/><circle class="ia-pulse" cx="24" cy="34" r="1.6" fill="currentColor" stroke="none"${d(3)}/>`),
  // Organizational nodes connect
  organization: () => wrap(`<rect x="17" y="5" width="14" height="9" rx="2.5"/><rect x="4" y="34" width="14" height="9" rx="2.5"/><rect x="30" y="34" width="14" height="9" rx="2.5"/><path class="ia-draw" pathLength="1" d="M24 14v10M11 34v-6h26v6"/>`),
  // Candidate enters pipeline
  recruitment: () => wrap(`<path d="M6 16h36M6 24h36M6 32h36" opacity=".28"/><rect x="6" y="11" width="10" height="26" rx="3"/><rect x="19" y="11" width="10" height="26" rx="3" opacity=".6"/><rect x="32" y="11" width="10" height="26" rx="3" opacity=".6"/><circle class="ia-slide" cx="11" cy="24" r="3.2" fill="currentColor" stroke="none"/>`),
  // Progress chart grows
  performance: () => wrap(`<path d="M7 41h34"/><rect class="ia-grow" x="10" y="28" width="7" height="13" rx="1.5"/><rect class="ia-grow"${d(1)} x="21" y="20" width="7" height="21" rx="1.5"/><rect class="ia-grow"${d(2)} x="32" y="10" width="7" height="31" rx="1.5"/><path class="ia-draw" pathLength="1"${d(3)} d="M10 20l11-8 10 2 8-8" opacity=".7"/>`),
  // Connected skill nodes
  talent: () => wrap(`<circle cx="24" cy="24" r="5"/><circle class="ia-pop" cx="9" cy="12" r="3.5"/><circle class="ia-pop"${d(1)} cx="39" cy="12" r="3.5"/><circle class="ia-pop"${d(2)} cx="9" cy="37" r="3.5"/><circle class="ia-pop"${d(3)} cx="39" cy="37" r="3.5"/><path class="ia-draw" pathLength="1" d="M12 14l8 7M36 14l-8 7M12 35l8-7M36 35l-8-7"/>`),
  // Reward indicator
  compensation: () => wrap(`<path class="ia-pulse" d="M24 5l5.3 10.8 11.7 1.7-8.5 8.3 2 11.7L24 32l-10.5 5.5 2-11.7L7 17.5l11.7-1.7z"/><path d="M14 43h20" opacity=".6"/>`),
  // Book opens
  learning: () => wrap(`<path d="M24 12v28"/><path class="ia-flip l" d="M24 12c-4-3-10-4-16-3v27c6-1 12 0 16 3"/><path class="ia-flip r" d="M24 12c4-3 10-4 16-3v27c-6-1-12 0-16 3"/><path d="M13 17c3 0 6 .5 8 1.5M13 23c3 0 6 .5 8 1.5" opacity=".5"/>`),
  // Receipt with line items
  expenses: () => wrap(`<path d="M10 5h28v38l-5-3-4.5 3-4.5-3-4.5 3-4.5-3-5 3z"/><path class="ia-draw" pathLength="1" d="M17 16h14M17 23h14"/><path class="ia-draw" pathLength="1"${d(2)} d="M17 30h7"/><circle class="ia-pop"${d(3)} cx="31" cy="30" r="2" fill="currentColor" stroke="none"/>`),
  // Checklist with ticks
  onboarding: () => wrap(`<rect x="8" y="7" width="32" height="34" rx="5"/><path class="ia-draw" pathLength="1" d="M14 17l3 3 5-6"/><path class="ia-draw" pathLength="1"${d(2)} d="M14 27l3 3 5-6"/><path d="M28 18h7M28 28h7" opacity=".55"/>`),
  // Speech bubbles
  surveys: () => wrap(`<path d="M6 8h26a3 3 0 013 3v14a3 3 0 01-3 3H17l-7 6v-6H6a3 3 0 01-3-3V11a3 3 0 013-3z" transform="translate(3 0)"/><g class="ia-grow"><rect x="12" y="19" width="3.5" height="5" rx="1" fill="currentColor" stroke="none"/></g><g class="ia-grow"${d(1)}><rect x="19" y="15" width="3.5" height="9" rx="1" fill="currentColor" stroke="none"/></g><g class="ia-grow"${d(2)}><rect x="26" y="12" width="3.5" height="12" rx="1" fill="currentColor" stroke="none"/></g><path d="M30 38h12a3 3 0 003-3V25" opacity=".5"/>`),
  // Appreciation heart
  recognition: () => wrap(`<path class="ia-pulse heart" d="M24 41S6 30 6 17.5A9.5 9.5 0 0124 12a9.5 9.5 0 0118 5.5C42 30 24 41 24 41z"/><path d="M15 17.5c.5-2.5 2.2-4 4.5-4" opacity=".6"/>`),
  // Help desk headset and ticket
  helpdesk: () => wrap(`<path d="M9 28v-5a15 15 0 0130 0v5"/><rect x="5" y="26" width="8" height="12" rx="3"/><rect x="35" y="26" width="8" height="12" rx="3"/><path d="M39 38c0 4-4 6-10 6"/><g class="ia-pulse"><circle cx="24" cy="25" r="2.2" fill="currentColor" stroke="none"/><path d="M19 25h.01M29 25h.01" stroke-width="3"/></g>`),
  // Document with acknowledgement
  documents: () => wrap(`<path d="M11 5h19l9 9v29H11z"/><path d="M30 5v9h9"/><path d="M17 22h14M17 28h8" opacity=".6"/><path class="ia-draw" pathLength="1"${d(1)} d="M17 37c3-5 4-5 6 0s3 2 8-2"/>`),
  // Asset box
  assets: () => wrap(`<path d="M24 5l17 8.5v21L24 43 7 34.5v-21z"/><path d="M7 13.5L24 22l17-8.5M24 22v21"/><g class="ia-float"><path d="M15 9.5l17 8.5" opacity=".5"/></g>`),
  // Chart bars animate
  analytics: () => wrap(`<path d="M6 6v36h36"/><rect class="ia-grow" x="12" y="26" width="6" height="12" rx="1.5"/><rect class="ia-grow"${d(1)} x="22" y="18" width="6" height="20" rx="1.5"/><rect class="ia-grow"${d(2)} x="32" y="10" width="6" height="28" rx="1.5"/>`),
  // Configuration sliders
  config: () => wrap(`<path d="M7 14h34M7 24h34M7 34h34" opacity=".4"/><circle class="ia-knob a" cx="16" cy="14" r="4" fill="var(--ico-fill,#fff)"/><circle class="ia-knob b" cx="32" cy="24" r="4" fill="var(--ico-fill,#fff)"/><circle class="ia-knob c" cx="20" cy="34" r="4" fill="var(--ico-fill,#fff)"/>`),
  // Employee self-service: person with phone
  "self-service": () => wrap(`<circle cx="17" cy="14" r="6"/><path d="M5 40c1-8 6-12 12-12s11 4 12 12"/><rect class="ia-float" x="30" y="16" width="12" height="22" rx="3"/><path d="M34 33h4" opacity=".6"/>`),
  // Manager self-service: person with approval tick
  manager: () => wrap(`<circle cx="20" cy="14" r="6"/><path d="M8 40c1-8 6-12 12-12s11 4 12 12"/><circle class="ia-pop" cx="36" cy="30" r="8" fill="var(--ico-fill,#fff)"/><path class="ia-draw" pathLength="1"${d(1)} d="M32 30l3 3 5-6"/>`),
  // Generic UI icons
  search: () => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg>`,
  arrow: () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  check: () => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  shield: () => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
};

// Lifecycle stages and other places reuse the module drawings.
ICONS.hire = ICONS.recruitment;
ICONS.onboard = ICONS.onboarding;
ICONS.manage = ICONS["core-hr"];
ICONS.pay = ICONS.payroll;
ICONS.develop = ICONS.learning;
ICONS.retain = ICONS.recognition;
ICONS["employee-self-service"] = ICONS["self-service"];
ICONS["manager-self-service"] = ICONS.manager;

export const icon = (name) => (ICONS[name] ? ICONS[name]() : "");
export const hasIcon = (name) => Boolean(ICONS[name]);
