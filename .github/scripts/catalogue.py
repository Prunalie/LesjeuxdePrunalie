"""Mise à jour du catalogue publié sur le site (dossier stickers-iso/catalogue).

Lit Firebase (lecture seule, clé publique du jeu) et écrit :
  - une image par sticker visible des joueurs (enveloppes en vente, ou retiré de la vente mais possédé) et par décor public ;
  - liste.json : les informations de ces stickers (sans les images), la date de la sauvegarde et les enveloppes couvertes.
Lancée toutes les heures. Par défaut, seuls les changements depuis la dernière sauvegarde sont lus (quelques documents).
Relecture complète : variable FULL=1, le dimanche vers 5 h, ou si un sticker a été supprimé depuis (réglage catalogFull).
"""
import base64, datetime, glob, hashlib, json, os, re, sys, time, urllib.request

OUT = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEY = re.search(r"apiKey:\s*'([^']+)'", open(os.path.join(ROOT, 'stickers-iso/firebase-config.js')).read()).group(1)
BASE = 'https://firestore.googleapis.com/v1/projects/lesjeuxdeprunalie/databases/(default)/documents'
reads = 0


def query(col, field, op, value):
    global reads
    body = {'structuredQuery': {'from': [{'collectionId': col}],
                                'where': {'fieldFilter': {'field': {'fieldPath': field}, 'op': op, 'value': value}}}}
    req = urllib.request.Request(f'{BASE}:runQuery?key={KEY}', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            rows = json.load(urllib.request.urlopen(req, timeout=300))
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt * 5)
    docs = [r['document'] for r in rows if 'document' in r]
    reads += max(1, len(docs))
    return [plain(d) for d in docs]


def get_doc(path):
    global reads
    reads += 1
    return plain(json.load(urllib.request.urlopen(f'{BASE}/{path}?key={KEY}', timeout=60)))


def val(v):
    k, x = next(iter(v.items()))
    if k == 'integerValue':
        return int(x)
    if k == 'nullValue':
        return None
    if k == 'mapValue':
        return {a: val(b) for a, b in x.get('fields', {}).items()}
    if k == 'arrayValue':
        return [val(b) for b in x.get('values', [])]
    return x


def plain(d):
    o = {a: val(b) for a, b in d.get('fields', {}).items()}
    o['id'] = d['name'].split('/')[-1]
    return o


start = int(time.time() * 1000)
today = datetime.datetime.now().strftime('%Y-%m-%d')  # TZ=Europe/Paris dans la tâche
old = None
if os.path.exists(f'{OUT}/liste.json'):
    old = json.load(open(f'{OUT}/liste.json'))
settings = get_doc('ma-petite-piece/settings')
envelopes = query('ma-petite-piece', 'type', 'EQUAL', {'stringValue': 'envelope'})
all_env = {e['id'] for e in envelopes}
live = {e['id'] for e in envelopes if not e.get('draft') and (not e.get('publishAt') or e['publishAt'] <= today)}

now = datetime.datetime.now()
full = (os.environ.get('FULL') == '1' or old is None or (now.weekday() == 6 and now.hour == 5)  # relecture complète : dimanche vers 5 h
        or (settings.get('catalogFull') or 0) > old.get('snapshot', 0))


def visible(o):
    """Ce que les joueurs peuvent voir : un sticker d'une enveloppe en vente, ou retiré de la vente (archivé)."""
    if o.get('deco'):
        return not o.get('adminOnly') and o.get('kind') not in ('halfwall', 'post')
    if not o.get('catalog'):
        return False
    e = o.get('envelope')
    return e in live or (e not in all_env and bool(o.get('archived')))


items = {}
if full:
    docs = query('ma-petite-piece-stickers', 'catalog', 'EQUAL', {'booleanValue': True})
    docs += query('ma-petite-piece-stickers', 'deco', 'EQUAL', {'booleanValue': True})
else:
    items = {o['id']: o for o in old['items']}
    since = old['snapshot'] - 2 * 3600 * 1000  # (2 h de marge pour les horloges décalées)
    docs = query('ma-petite-piece-stickers', 'updated', 'GREATER_THAN', {'integerValue': str(since)})
    new_live = sorted(live - set(old.get('envelopes', [])))
    for i in range(0, len(new_live), 30):
        chunk = new_live[i:i + 30]
        docs += query('ma-petite-piece-stickers', 'envelope', 'IN',
                      {'arrayValue': {'values': [{'stringValue': x} for x in chunk]}})
    # Une enveloppe repassée en brouillon : ses stickers sortent de la liste.
    for k in [k for k, o in items.items() if not visible(o)]:
        del items[k]

os.makedirs(OUT, exist_ok=True)
added = changed = removed = 0
for o in docs:
    if not (o.get('catalog') or o.get('deco')) or o.get('proposal'):
        continue
    if not visible(o) or not o.get('data'):
        if items.pop(o['id'], None):
            removed += 1
        continue
    head, b64 = o.pop('data').split(',', 1)
    raw = base64.b64decode(b64)
    ext = 'webp' if 'webp' in head else 'png'
    sha = hashlib.sha1(raw).hexdigest()[:12]
    fn = f"{o['id']}.{ext}"
    path = f'{OUT}/{fn}'
    if not os.path.exists(path) or hashlib.sha1(open(path, 'rb').read()).hexdigest()[:12] != sha:
        open(path, 'wb').write(raw)
        changed += 1
    if o['id'] not in items:
        added += 1
    o['file'], o['v'] = fn, sha
    items[o['id']] = o

keep = {o['file'] for o in items.values()}
for f in glob.glob(f'{OUT}/*'):
    name = os.path.basename(f)
    if name != 'liste.json' and name not in keep:
        os.remove(f)

ordered = sorted(items.values(), key=lambda o: (o.get('created') or 0, o['id']))
if old and not full and old.get('items') == ordered and old.get('envelopes') == sorted(live):
    print(f'rien de nouveau ({reads} lectures Firebase)')
    sys.exit(0)  # la liste ne change pas : on garde sa date (rien à enregistrer ni à republier)
json.dump({'snapshot': start, 'envelopes': sorted(live), 'items': ordered},
          open(f'{OUT}/liste.json', 'w'), separators=(',', ':'), ensure_ascii=False)
print(f"{'complète' if full else 'partielle'} : {len(ordered)} éléments, {added} nouveaux, {changed} images écrites, "
      f"{removed} retirés, {reads} lectures Firebase")
