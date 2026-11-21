#!/usr/bin/env python3
"""司法試験・予備試験（論文式）の問題・出題趣旨・採点実感を、法務省のPDFから
科目ごとの文のデータ（data/exam/*.json）に変換する。

使い方（リポジトリの一番上で）:
  python3 tools/exam-fetch/build.py <PDFを置くフォルダ>

- 取得する資料の一覧は tools/exam-fetch/sources.json（年度ごとのページから手で集めたURL）。
  新しい年度が出たら、法務省の「司法試験の結果について」「司法試験予備試験の結果について」
  （予備試験の問題は「司法試験予備試験の実施について」側）の年度ページからPDFのURLを足す。
- PDFが手元に無ければ取得する（2秒ずつ間を空け、正直に名乗る。取得済みは再取得しない）。
- 文の抜き出しには poppler の pdftotext（-layout）を使う。日本語のPDFの一部は
  poppler-data（Adobe-Japan1 の対応表）が無いと文が取れない（apt-get install poppler-data）。
- 出典：法務省ウェブサイト。公共データ利用規約（PDL1.0）に従い、各資料に元のページのURLを
  持たせ、アプリ側で「法務省ウェブサイト（URL）を加工して作成」と表示する。
"""
import hashlib, json, os, re, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCES = os.path.join(ROOT, 'tools', 'exam-fetch', 'sources.json')
OUT_DIR = os.path.join(ROOT, 'data', 'exam')
USER_AGENT = 'exam-pdf-fetcher/1.0'

EXAM_LABEL = {'shiho': '司法試験', 'yobi': '予備試験'}
KIND_LABEL = {'mondai': '問題', 'shushi': '出題趣旨', 'jikkan': '採点実感'}
# アプリの年度×科目の表（js/past-exam.js の PAST_EXAM_MATRIX_SUBJECTS）と同じ10科目
SUBJECTS = ['憲法', '行政法', '民法', '商法', '民事訴訟法', '刑法', '刑事訴訟法', '労働法',
            '実務基礎民事', '実務基礎刑事']
# 司法試験：系ごとの第N問 → 科目
SHIHO_QUESTION = {
    ('公法系科目', 1): '憲法', ('公法系科目', 2): '行政法',
    ('民事系科目', 1): '民法', ('民事系科目', 2): '商法', ('民事系科目', 3): '民事訴訟法',
    ('刑事系科目', 1): '刑法', ('刑事系科目', 2): '刑事訴訟法',
}
# ［　］見出しの科目名（空白を除いたもの）→ 科目。None は「ここで前の科目が終わる」だけの見出し
BRACKET_SUBJECT = {
    '憲法': '憲法', '行政法': '行政法', '民法': '民法', '商法': '商法', '民事訴訟法': '民事訴訟法',
    '刑法': '刑法', '刑事訴訟法': '刑事訴訟法', '労働法': '労働法',
    '民事': '実務基礎民事', '刑事': '実務基礎刑事',
    '法律実務基礎科目（民事）': '実務基礎民事', '法律実務基礎科目（刑事）': '実務基礎刑事',
    '倒産法': None, '租税法': None, '経済法': None, '知的財産法': None, '環境法': None,
    '国際関係法（公法系）': None, '国際関係法（私法系）': None, '一般教養科目': None,
}

ZEN_DIGITS = str.maketrans('０１２３４５６７８９', '0123456789')


def nospace(s):
    return re.sub(r'[\s　]+', '', s)


def to_int(s):
    return int(s.translate(ZEN_DIGITS))


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    time.sleep(2)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    with open(dest, 'wb') as f:
        f.write(data)


def pdf_lines(path):
    out = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True)
    text = out.stdout.decode('utf-8', 'replace')
    lines = []
    for raw in text.replace('\f', '\n').split('\n'):
        l = raw.rstrip()
        s = l.strip()
        # ページ番号（「- 1 -」「－１－」）と、ページごとに入る問題集の見出し
        if re.fullmatch(r'[-－‐]?\s*[0-9０-９]+\s*[-－‐]|[-－‐]\s*[0-9０-９]+', s):
            continue
        if re.fullmatch(r'[0-9０-９]+', s):
            continue
        if re.fullmatch(r'論文式試験問題集［[^］]*］', s):
            continue
        lines.append(l)
    return lines


def disp_width(s):
    w = 0
    for ch in s:
        w += 2 if ord(ch) > 0x2E7F else 1
    return w


def indent_of(l):
    n = 0
    for ch in l:
        if ch == ' ':
            n += 1
        elif ch == '　':
            n += 2
        else:
            break
    return n


# 前の行が文の終わりで切れていて、行頭がこれなら、新しい段落（見出し・箇条書き）にする
NEW_PARA = re.compile(
    r'^(〔|【|［|\[|（出題の趣旨）|（趣旨）|・|○|●|◯|※|'
    r'[0-9０-９]+[\s　．.、)）]|[⑴-⒇①-⑳]|[(（][0-9０-９ア-ンa-zａ-ｚⅰ-ⅹ]+[)）]|'
    r'[ア-ン][\s　．.、)）]|第[0-9０-９一二三四五六七八九十]+[\s　])')
SENTENCE_END = re.compile(r'[。」）)：:】〕］]$')


def right_edge(l):
    return indent_of(l) + disp_width(l.strip())


def to_paragraphs(lines):
    """pdftotext -layout の行を段落にまとめる。
    行の右端がほぼ一杯まで来ていれば次の行に続く（日本語なので空白なしでつなぐ）。
    - 短い行の次は新しい段落。
    - 前の行が文の終わり（。など）で、行頭が見出し・番号・○なら新しい段落。
    - 2行目から下げる書き方（「○ …」「甲：…」のぶら下げ）は続きとみなす。
      3行目以降で2行目より深く下がった行は、字下げした新しい段落の1行目とみなす。
    - 前の行が文の終わりで、段落の1行目より浅く始まる行は新しい段落。
    - 1行の幅が少し狭いページもあるので、文の途中で終わる長めの行は続きとみなす。
    - 空行（ページの変わり目）をはさんでも、文の途中なら続きとみなす。"""
    body = [l for l in lines if l.strip()]
    if not body:
        return []
    edges = sorted(right_edge(l) for l in body)
    full = edges[int(len(edges) * 0.9)] if len(edges) > 3 else edges[-1]
    paras = []
    cur = None
    prev_full = False
    prev_end = True
    cont_indent = None  # 段落の2行目の字下げ（まだ1行だけなら None）
    first_indent = 0
    for l in lines:
        s = l.strip()
        if not s:
            # 空行（ページの変わり目を含む）。前の行が文の途中で一杯まで来ていれば、
            # ページをまたいで続く文なので段落を閉じない
            if cur is not None and not (prev_full and not prev_end):
                paras.append(cur)
                cur = None
                prev_full = False
                prev_end = True
            continue
        ind = indent_of(l)
        s = re.sub(r'[ 　]{2,}', '　', s)
        if cur is None or not prev_full:
            starts_new = True
        elif prev_end and NEW_PARA.match(s):
            starts_new = True
        elif cont_indent is not None and ind > cont_indent + 1:
            starts_new = True
        elif prev_end and ind < first_indent - 1 and (cont_indent is None or ind < cont_indent - 1):
            starts_new = True
        else:
            starts_new = False
        if starts_new:
            if cur is not None:
                paras.append(cur)
            cur = s
            first_indent = ind
            cont_indent = None
        else:
            cur += s
            if cont_indent is None:
                cont_indent = ind
        prev_end = SENTENCE_END.search(s) is not None
        # ページによって1行の幅が少し狭いことがあるので、文の途中で切れている長めの行も続きとみなす
        edge = right_edge(l)
        prev_full = edge >= full - 4 or (not prev_end and edge >= full * 0.75)
    if cur is not None:
        paras.append(cur)
    return [p for p in paras if p.strip()]


def split_by(lines, is_head):
    """is_head(line) が値を返した行で区切り、[(値, 区切り行以降の行)] を返す"""
    out = []
    cur = None
    for l in lines:
        h = is_head(l)
        if h is not None:
            cur = (h, [l])
            out.append(cur)
        elif cur is not None:
            cur[1].append(l)
    return out


def bracket_head(l):
    # 「［憲 法]」「[商 法]」「］(〔設問１〕…）」のように半角の括弧が混じる年度がある
    m = re.match(r'^\s*[［\[]([^］\]]{1,30})[］\]]\s*([(（].*[)）])?\s*$', l)
    if not m:
        return None
    name = nospace(m.group(1))
    if name in BRACKET_SUBJECT:
        return ('subj', BRACKET_SUBJECT[name])
    return None


def sections_shiho_mondai(group, lines):
    res = {}
    if group == '選択科目':
        for (_, subj), ls in split_by(lines, bracket_head):
            if subj == '労働法':
                res[subj] = ls
        return res
    def head(l):
        m = re.match(r'^\s*〔第([0-9０-９])問〕', l)
        return to_int(m.group(1)) if m else None
    for q, ls in split_by(lines, head):
        subj = SHIHO_QUESTION.get((group, q))
        if subj:
            # 次の問の前に入る「［民事系科目］」の行は落とす
            res[subj] = [l for l in ls if not re.fullmatch(r'\s*［[^］]*系科目］\s*', l)]
    return res


def sections_shiho_shushi(lines):
    res = {}
    group = [None]
    def head(l):
        s = nospace(l)
        m = re.fullmatch(r'【(公法系科目|民事系科目|刑事系科目|選択科目)】', s)
        if m:
            group[0] = m.group(1)
            return ('group', m.group(1))
        m = re.match(r'^\s*〔第([0-9０-９])問〕\s*$', l)
        if m and group[0] != '選択科目':
            return ('q', SHIHO_QUESTION.get((group[0], to_int(m.group(1)))))
        b = bracket_head(l)
        if b and group[0] == '選択科目':
            return b
        return None
    for (_, subj), ls in split_by(lines, head):
        if subj:
            res[subj] = ls
    return res


def sections_shiho_jikkan(group, lines):
    res = {}
    def head(l):
        m = re.match(r'^\s*令和.{1,2}年司法試験の採点実感（(.+)）\s*$', l)
        if not m:
            return None
        t = nospace(m.group(1))
        m2 = re.fullmatch(r'(公法系科目|民事系科目|刑事系科目)第([0-9０-９])問', t)
        if m2:
            return ('q', SHIHO_QUESTION.get((m2.group(1), to_int(m2.group(2)))))
        # 対象外の科目（環境法など）の見出しも「前の科目の終わり」として区切る
        return ('subj', BRACKET_SUBJECT.get(t))
    for (_, subj), ls in split_by(lines, head):
        if subj:
            res[subj] = ls[1:]  # 見出しの行そのものは画面の見出しと重なるので落とす
    return res


def sections_yobi_mondai(lines):
    res = {}
    for (_, subj), ls in split_by(lines, bracket_head):
        if subj:
            res[subj] = ls
    return res


def sections_yobi_shushi(lines):
    """予備試験の出題趣旨は「問題文 →（出題の趣旨）→ 趣旨」の順。趣旨の部分だけを取る"""
    res = {}
    for (_, subj), ls in split_by(lines, bracket_head):
        if not subj:
            continue
        idx = None
        for i, l in enumerate(ls):
            if re.fullmatch(r'\s*（出題の趣旨）\s*', l):
                idx = i
                break
        if idx is not None:
            res[subj] = ls[idx + 1:]
    return res


def page_title(d):
    return '%s 令和%s年 %s（%s）' % (
        EXAM_LABEL[d['exam']], '元' if d['year'] == 1 else d['year'], KIND_LABEL[d['kind']],
        '全科目' if d['group'] == 'all' else d['group'])


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cache = sys.argv[1]
    os.makedirs(cache, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    sources = json.load(open(SOURCES, encoding='utf-8'))
    years = {}
    problems = []
    for d in sources:
        pdf = os.path.join(cache, d['pdf'].split('/')[-1])
        fetch(d['pdf'], pdf)
        lines = pdf_lines(pdf)
        if d['exam'] == 'shiho' and d['kind'] == 'mondai':
            secs = sections_shiho_mondai(d['group'], lines)
        elif d['exam'] == 'shiho' and d['kind'] == 'shushi':
            secs = sections_shiho_shushi(lines)
        elif d['exam'] == 'shiho' and d['kind'] == 'jikkan':
            secs = sections_shiho_jikkan(d['group'], lines)
        elif d['exam'] == 'yobi' and d['kind'] == 'mondai':
            secs = sections_yobi_mondai(lines)
        elif d['exam'] == 'yobi' and d['kind'] == 'shushi':
            secs = sections_yobi_shushi(lines)
        else:
            continue
        y = years.setdefault((d['exam'], d['year']), {})
        for subj, ls in secs.items():
            paras = to_paragraphs(ls)
            if not paras:
                problems.append('空: %s %s %s %s' % (d['exam'], d['year'], d['kind'], subj))
                continue
            y.setdefault(subj, {})[d['kind']] = {
                'paras': paras,
                'pdf': d['pdf'],
                'page': d['page'],
                'title': page_title(d),
            }
    index = []
    for (exam, year), subjects in sorted(years.items(), key=lambda kv: (kv[0][0], -kv[0][1])):
        name = '%s-R%d.json' % (exam, year)
        doc = {'exam': EXAM_LABEL[exam], 'year': year, 'subjects': {}}
        avail = {}
        for subj in SUBJECTS:
            if subj in subjects:
                doc['subjects'][subj] = subjects[subj]
                avail[subj] = [k for k in ('mondai', 'shushi', 'jikkan') if k in subjects[subj]]
        body = json.dumps(doc, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(OUT_DIR, name), 'w', encoding='utf-8') as f:
            f.write(body)
        # rev：中身が変わったら変わる印。アプリは端末に保存した控えの rev と比べて、
        # 違っていれば取り直す（文の抜き出し方を直して作り直したときのため）
        rev = hashlib.sha1(body.encode('utf-8')).hexdigest()[:12]
        index.append({'exam': EXAM_LABEL[exam], 'year': year, 'file': name, 'rev': rev,
                      'bytes': len(body.encode('utf-8')), 'subjects': avail})
    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'source': '法務省ウェブサイト', 'years': index}, f,
                  ensure_ascii=False, indent=1)
    for p in problems:
        print(p)
    for e in index:
        print(e['exam'], e['year'], e['bytes'], {k: ''.join(x[0] for x in v) for k, v in e['subjects'].items()})


if __name__ == '__main__':
    main()
