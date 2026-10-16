// Parcel-ID personal-info check, used by verify.mjs (and so by preflight) before any root is posted.
//
// A packet is public and its root is permanent, so parcel_id must never carry an owner's name or contact data.
// Rejected:
//   email     anything shaped like an email address
//   owner     owner/vesting keywords: LLC, TRUST(EE), ESTATE OF, ETAL, ET AL, ET UX, ET VIR, REVOCABLE, HEIRS, INC, CORP, ...
//   last_first  digit-free "X; Y" or "X, Y" (assessor LAST; FIRST owner style)
//   name      digit-free IDs of 2-4 plain words that contain a common given name and no place/plat word
//             (roads, condos, common areas, cemeteries, ... are allowed)
// Phone and SSN shapes are NOT checked: many counties' own parcel formats look like them
// (e.g. 99999-999-999-9999, 9999-99-99-9999), so those checks only produced false positives on live data.
// Known false positives that are real place names go in pii-allowlist.json (exact IDs, case-insensitive).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ALLOWLIST_FILE = path.join(here, "pii-allowlist.json");

const GIVEN = new Set(`JAMES JOHN ROBERT MICHAEL WILLIAM DAVID RICHARD JOSEPH THOMAS CHARLES CHRISTOPHER DANIEL MATTHEW ANTHONY MARK
DONALD STEVEN PAUL ANDREW JOSHUA KENNETH KEVIN BRIAN GEORGE TIMOTHY RONALD EDWARD JASON JEFFREY RYAN JACOB GARY NICHOLAS ERIC
JONATHAN STEPHEN LARRY JUSTIN SCOTT BRANDON BENJAMIN SAMUEL GREGORY FRANK ALEXANDER RAYMOND PATRICK JACK DENNIS JERRY TYLER
AARON JOSE ADAM HENRY NATHAN DOUGLAS ZACHARY PETER KYLE WALTER ETHAN JEREMY HAROLD KEITH CHRISTIAN ROGER NOAH GERALD CARL TERRY
SEAN AUSTIN ARTHUR LAWRENCE JESSE DYLAN BRYAN JOE JORDAN BILLY BRUCE ALBERT WILLIE GABRIEL LOGAN ALAN JUAN WAYNE ROY RALPH RANDY
EUGENE VINCENT RUSSELL ELIJAH LOUIS BOBBY PHILIP JOHNNY EARL HOWARD FRED HERBERT LEROY CLARENCE ERNEST HAROLD MARVIN LLOYD
FLOYD LEON MELVIN OSCAR HOMER CHESTER LUTHER OTIS WILBUR VIRGIL ELMER CECIL HERMAN MILTON LESTER CURTIS ALVIN CLYDE
MARY PATRICIA JENNIFER LINDA ELIZABETH BARBARA SUSAN JESSICA SARAH KAREN NANCY LISA BETTY MARGARET SANDRA ASHLEY KIMBERLY EMILY
DONNA MICHELLE DOROTHY CAROL AMANDA MELISSA DEBORAH STEPHANIE REBECCA SHARON LAURA CYNTHIA KATHLEEN AMY SHIRLEY ANGELA HELEN ANNA
BRENDA PAMELA NICOLE EMMA SAMANTHA KATHERINE CHRISTINE DEBRA RACHEL CATHERINE CAROLYN JANET RUTH MARIA HEATHER DIANE VIRGINIA
JULIE JOYCE VICTORIA OLIVIA KELLY CHRISTINA LAUREN JOAN EVELYN JUDITH MEGAN CHERYL ANDREA HANNAH MARTHA JACQUELINE FRANCES GLORIA
ANN TERESA KATHRYN SARA JANICE JEAN ALICE MADISON DORIS ABIGAIL JULIA JUDY GRACE DENISE AMBER MARILYN BEVERLY DANIELLE THERESA
SOPHIA MARIE DIANA BRITTANY NATALIE ISABELLA CHARLOTTE ROSE ALEXIS KAYLA JOSEPHINE JANE JUANITA GERTRUDE MILDRED EDNA ETHEL
HAZEL LOIS IRENE THELMA BERNICE BESSIE MABEL VERA PEARL ESTHER MYRTLE MINNIE IDA LUCILLE GLADYS AGNES VIOLA OPAL LOUISE EDITH
CARLOS LUIS JESUS MANUEL MIGUEL JORGE PEDRO RAFAEL FRANCISCO RAMON ROSA CARMEN`.split(/\s+/));

const PLACE = new Set(`ST STREET AVE AVENUE RD ROAD DR DRIVE LN LANE CT COURT BLVD WAY PL PLACE CIR CIRCLE TER TERRACE PKWY HWY HIGHWAY
TRL TRAIL SQ SQUARE PIKE ALY ALLEY CONDO CONDOS COND CONDS CONDOMINIUM CONDOMINIUMS UNIT UNITS APT LOT LOTS OUTLOT BLK BLOCK SUB SUBD
SUBDIVISION ADD ADDN ADDITION PARK ESTATES TRACT TRACTS PHASE PH STAGE COMMON COMMONS AREA PLAT ROW ACRES ACREAGE RANCH FARM FARMS
HEIGHTS HILLS HILL VILLAGE VILLAS VILLA MANOR GARDENS GARDEN POINTE POINT CREEK LAKE LAKES RIVER WOODS FOREST RIDGE VIEW VISTA
MEADOWS MEADOW PLAZA CENTER CENTRE TOWER TOWERS COOP APARTMENTS BUILDING BLDG HOA ASSOC ASSOCIATION OPEN SPACE GREENBELT RESERVE
DRAINAGE EASEMENT UTILITY RAILROAD RR CANAL DITCH WATER PRIVATE PUBLIC COUNTY CO CITY STATE TOWN SCHOOL CHURCH CEMETERY CEMETARY
SECTION TOWNSHIP PARCEL SPLIT DEDICATED POND LEVEE TOWNHOMES TOWNHOUSES LOFTS OFFICE CROSSING RESURVEY REPLAT DIVISION GULLY
BAYOU ISLAND RESERVOIR GOLF COURSE MOBILE HOME GARAGE STORAGE PARKING`.split(/\s+/));

const EMAIL = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/;
const OWNER = /\b(L\.?L\.?C|LLP|TRUSTS?|TRUSTEES?|ESTATE OF|ET ?AL|ET ?UX|ET ?VIR|REVOCABLE|IRREVOCABLE|HEIRS|INC|CORP|CORPORATION|LTD)\b/i;
const LAST_FIRST = /^\s*[A-Za-z][A-Za-z'.-]+\s*[;,]\s*[A-Za-z][A-Za-z'. -]+$/;

export function loadAllowlist(file = ALLOWLIST_FILE) {
  if (!fs.existsSync(file)) return new Set();
  return new Set((JSON.parse(fs.readFileSync(file, "utf8")).allow ?? []).map((e) => String(e.id).trim().toUpperCase()));
}

/** Return the reason a parcel ID looks like personal info, or null. */
export function piiReason(id, allow = new Set()) {
  const s = String(id).trim();
  if (allow.has(s.toUpperCase())) return null;
  if (EMAIL.test(s)) return "email";
  if (OWNER.test(s)) return "owner";
  if (/\d/.test(s)) return null;
  if (LAST_FIRST.test(s)) return "last_first";
  // whitespace-separated words only; hyphenated codes like SG-ROSA-A are one token, not a name
  const toks = s.toUpperCase().split(/\s+/);
  if (toks.length < 2 || toks.length > 4 || !toks.every((t) => /^[A-Z][A-Z'.]*$/.test(t))) return null;
  const words = toks.map((t) => t.replace(/[.']/g, ""));
  if (!words.some((t) => PLACE.has(t)) && words.some((t) => GIVEN.has(t))) return "name";
  return null;
}

/** Mask an ID for logs: first word, then initials. Never print a flagged ID in full. */
export function maskId(id) {
  const t = String(id).replace(/[;,]/g, " ").split(/\s+/).filter(Boolean);
  if (t.length < 2) return String(id).slice(0, 3) + "***";
  return [t[0], ...t.slice(1).map((x) => x[0] + "***")].join(" ");
}

/** Scan rows ({parcel_id}) and return [{row, reason, masked}] (row numbers are CSV lines, header = 1). */
export function scanRows(rows, allow = loadAllowlist()) {
  const hits = [];
  rows.forEach((r, i) => { const why = piiReason(r.parcel_id, allow); if (why) hits.push({ row: i + 2, reason: why, masked: maskId(r.parcel_id) }); });
  return hits;
}
