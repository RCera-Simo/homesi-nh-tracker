// Stage clock (added 2026-10-21, per Ricardo — "¿hay forma de contabilizar
// cuánto dura cada nodo?"). PURE computation, no network: given the monday
// activity-log events that _lib/stagesync.js collected, work out when each of
// the four stages that have no date column of their own started and ended:
//
//   Supreme HR Verification  start = packet received (Supreme's own date)
//                            end   = the moment Background Check, NMLS Access
//                                    and I-9 Documents were ALL done
//   Equipment & Access       start = request sent to Supreme
//                            end   = Supreme Systems Access "Done" (and, when a
//                                    PC was requested, equipment received)
//   New Hire Welcome         start = HR verification finished
//                            end   = Supreme's "Complete" flag set to Yes
//   HomeSí Activation        start = "Complete" set to Yes
//                            end   = Estado General set to Completado
//
// Event shape (written by stagesync.js): events["<boardId>:<itemId>"][columnId]
// = [[epochMs, label], ...] sorted oldest first. "label" is the status label,
// the date, or the text the column was set to (null when cleared).
//
// Honesty rules (same as the rest of this codebase): when a start or an end
// cannot be established from real evidence the stage gets NO duration — never a
// guess. A column that is done today but has no logged event (it was set before
// the log window, or at creation) is simply left out of the "latest of" maths.

const DONE_WORDS = ["completed", "yes", "done", "not applicable", "n/a", "na"];
const EQUIP_OK = ["sent - received all", "not applicable"];
const norm = (s) => (s == null ? "" : String(s)).trim().toLowerCase();

function eventList(events, boardId, itemId, columnId) {
  if (!events || !boardId || !itemId) return [];
  const item = events[`${boardId}:${itemId}`];
  return (item && item[columnId]) || [];
}

// When did this column ENTER the accepted state and stay there until now?
// Looks at the newest event; if it is not accepted the column is not (known to
// be) done, so there is no completion time. Otherwise walks back over the
// unbroken run of accepted events and returns the first of them — so a status
// that was flipped Completed -> Submitted -> Completed counts from the LAST
// flip, not the first one.
function enteredAt(list, accept) {
  if (!list || !list.length) return null;
  let i = list.length - 1;
  if (!accept(list[i][1])) return null;
  while (i > 0 && accept(list[i - 1][1])) i -= 1;
  return list[i][0];
}

function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
const maxKnown = (arr) => {
  const k = arr.filter((x) => typeof x === "number" && !isNaN(x));
  return k.length ? Math.max(...k) : null;
};

// ctx: { events, boards:{supreme,onboarding,pipeline}, ids:{supreme,onboarding,pipeline},
//        cols:{...}, supreme, onboarding, noPc, sentRaw }
function computeStageClock(ctx) {
  const { events, boards, ids, cols, supreme, onboarding, noPc, sentRaw } = ctx;
  const done = (l) => DONE_WORDS.includes(norm(l));
  const ev = (board, item, col) => eventList(events, boards[board], ids[item], cols[col]);

  // --- Supreme HR Verification ---
  const hrStart = toMs(supreme && supreme.packetReceived);
  const hrFieldTimes = [
    enteredAt(ev("supreme", "supreme", "backgroundCheck"), done),
    enteredAt(ev("supreme", "supreme", "nmlsAccess"), done),
    enteredAt(ev("supreme", "supreme", "i9"), done),
  ];
  const hrEnd = maxKnown(hrFieldTimes);

  // --- Equipment & Access ---
  const accessAt = enteredAt(ev("onboarding", "onboarding", "supremeOnboarding"), done);
  const equipAt = noPc ? null : enteredAt(ev("onboarding", "onboarding", "equipmentStatus"), (l) => EQUIP_OK.includes(norm(l)));
  const eqStart = toMs(sentRaw);
  const eqEnd = maxKnown([accessAt, equipAt]);

  // --- New Hire Welcome ---
  const completeAt = enteredAt(ev("supreme", "supreme", "complete"), (l) => norm(l) === "yes");
  const welcomeStart = hrEnd;
  const welcomeEnd = completeAt;

  // --- HomeSí Activation ---
  const activatedAt = enteredAt(ev("pipeline", "pipeline", "estado"), (l) => norm(l).includes("completado"));

  return {
    supreme_hr: { start: hrStart, end: hrEnd },
    equipment: { start: eqStart, end: eqEnd },
    new_hire_welcome: { start: welcomeStart, end: welcomeEnd },
    activated: { start: completeAt, end: activatedAt },
  };
}

// Copies a computed {start,end} onto a stage object (mutates it):
//   startedAt / endedAt (ISO), days, ongoing, and — for a finished stage with a
//   known end — the real completion date the UI prints next to the node.
function applyClock(stage, clock, nowMs) {
  if (!stage || !clock) return stage;
  const { start, end } = clock;
  stage.startedAt = start ? new Date(start).toISOString() : null;
  stage.endedAt = end ? new Date(end).toISOString() : null;
  stage.ongoing = false;
  if (stage.state === "done") {
    if (start && end && end >= start) stage.days = Math.round((end - start) / 86400000);
    if (end && !stage.date) {
      stage.date = new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    }
  } else if ((stage.state === "current") && start && start <= nowMs) {
    stage.days = Math.floor((nowMs - start) / 86400000);
    stage.ongoing = true;
  }
  return stage;
}

module.exports = { computeStageClock, applyClock, enteredAt };
