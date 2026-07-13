#!/usr/bin/env bash
#
# Add a school to the one site. It gets its own path, its own data, its own
# password — at zero extra hosting cost.
#
#   ./new-school.sh tarleton "Tarleton State" TSU Texans "#4F2683"
#
# The schools on this box play each other, so isolation is enforced in the server,
# not by convention: separate data directories, and a session token HMAC'd with the
# team inside it (an ACU cookie will not validate against /api/tarleton). See the
# MULTI-TENANT block in server.js.
#
set -euo pipefail

ID=${1:?school id, lowercase, no spaces (e.g. tarleton)}
SCHOOL=${2:?full name (e.g. "Tarleton State")}
SHORT=${3:?2-4 letter monogram (e.g. TSU)}
MASCOT=${4:?mascot (e.g. Texans)}
PRIMARY=${5:?official hex (e.g. "#4F2683")}
ACCENT_DARK=${6:-}
ON_PRIMARY=${7:-#ffffff}

# Contrast against the near-black film-room UI. Most college brand colors are deep
# (navy, maroon, purple) and vanish as an accent on #0a0d12 — so each school needs a
# BRIGHTENED variant for dark mode. This refuses to let you ship an invisible accent.
contrast() {
  python3 - "$1" <<'PY'
import sys
h=sys.argv[1].lstrip('#')
r,g,b=(int(h[i:i+2],16) for i in (0,2,4))
lin=lambda c:(c/255)/12.92 if (c/255)<=0.03928 else (((c/255)+0.055)/1.055)**2.4
rl=lambda r,g,b:0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)
fg,bg=rl(r,g,b),rl(10,13,18)
print(round((max(fg,bg)+0.05)/(min(fg,bg)+0.05),1))
PY
}

if [ -z "$ACCENT_DARK" ]; then
  echo "No accentDark given — deriving one by lightening $PRIMARY until it's legible on black."
  ACCENT_DARK=$(python3 - "$PRIMARY" <<'PY'
import sys,colorsys
h=sys.argv[1].lstrip('#')
r,g,b=(int(h[i:i+2],16)/255 for i in (0,2,4))
hh,l,s=colorsys.rgb_to_hls(r,g,b)
for L in [x/100 for x in range(int(l*100),96)]:
    rr,gg,bb=colorsys.hls_to_rgb(hh,L,s)
    lin=lambda c:c/12.92 if c<=0.03928 else ((c+0.055)/1.055)**2.4
    fg=0.2126*lin(rr)+0.7152*lin(gg)+0.0722*lin(bb)
    bg=0.2126*lin(10/255)+0.7152*lin(13/255)+0.0722*lin(18/255)
    if (fg+0.05)/(bg+0.05) >= 4.5:
        print('#%02x%02x%02x'%(int(rr*255),int(gg*255),int(bb*255))); break
PY
)
fi

CR_PRIMARY=$(contrast "$PRIMARY")
CR_ACCENT=$(contrast "$ACCENT_DARK")
echo
echo "  $SCHOOL ($SHORT) — $MASCOT"
echo "  primary     $PRIMARY      contrast on black: ${CR_PRIMARY}:1  (used for the mark, light mode, print)"
echo "  accentDark  $ACCENT_DARK  contrast on black: ${CR_ACCENT}:1  (used for the dark-mode accent)"
if python3 -c "import sys; sys.exit(0 if float('$CR_ACCENT') >= 4.5 else 1)"; then
  echo "  -> passes WCAG AA."
else
  echo "  -> FAILS AA (${CR_ACCENT}:1). Pass a lighter accentDark as argument 6."; exit 1
fi

# 1. add to teams.json
python3 - <<PY
import json
t=json.load(open('teams.json'))
t["$ID"]={"school":"$SCHOOL","short":"$SHORT","mascot":"$MASCOT",
          "primary":"$PRIMARY","accentDark":"$ACCENT_DARK",
          "onPrimary":"$ON_PRIMARY","secondary":"#c5c6c8"}
json.dump(t,open('teams.json','w'),indent=2)
print("\n  teams.json updated.")
PY

# 2. done — no new service. One site, one path per school.
PW=$(openssl rand -base64 12)
VAR="TEAM_PASSWORD_$(echo "$ID" | tr '[:lower:]' '[:upper:]')"

cat <<EOF

  SHIP IT
  -------
  1. Push:
         git add -A && git commit -m "Add $SCHOOL" && git push

  2. Render -> your gridiron-iq service -> Environment -> add:
         $VAR = $PW

     Until that variable exists, /$ID is OPEN — anyone with the link reads this
     program's film. The server logs the warning at boot and the app shows a red
     bar, but do not rely on either. Set it.

  3. Render redeploys on push. Then give the coach:
         https://gridiron-iq.onrender.com/$ID
         password: $PW

  COST: \$0 extra. This school shares the existing service. Only the Anthropic
        API meter moves — roughly \$9 per game charted.
EOF
