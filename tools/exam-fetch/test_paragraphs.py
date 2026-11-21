#!/usr/bin/env python3
"""build.py の段落つなぎ直し（to_paragraphs）の自動テスト。PDFもネットワークも使わず、
行の字下げ・長さを作った文で確かめる。実行: python3 tools/exam-fetch/test_paragraphs.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build

fails = 0


def check(label, actual, expected):
    global fails
    ok = actual == expected
    print(('  ✅ ' if ok else '  ❌ ') + label + ('' if ok else '\n     期待 %r\n     実際 %r' % (expected, actual)))
    if not ok:
        fails += 1


def full(text, indent=16):
    """右端まで一杯の行（全角40字）"""
    assert len(text) == 40, len(text)
    return ' ' * indent + text


def pad(n=4):
    """右端の位置（full）を決めるための、一杯まで来ている行（それぞれ別の段落になるよう文末で終える）"""
    return [full('い' * 39 + '。') if i % 2 == 0 else full('う' * 39 + '。') for i in range(n)]


def paras_with(lines, needle):
    return [p for p in build.to_paragraphs(pad() + lines) if needle in p]


def in_one(lines, a, b):
    ps = build.to_paragraphs(pad() + lines)
    return any(a in p and b in p for p in ps)


# 1. 読点で終わる短い行と、字下げの大きい続きの行（「この点は、」「「時効取得と登記」として…」）
lines = [' ' * 16 + 'その上で、時効取得者が対抗できるかが問題となる。この点は、',
         ' ' * 35 + '「時効取得と登記」として古くから論じられている問題であり、学説上は様々な見',
         ' ' * 16 + '解が主張されているが、判例は次のように考えている。']
check('読点で終わる行は、字下げが大きい次の行も同じ段落', in_one(lines, 'この点は、「時効取得と登記」', '判例は次のように'), True)

# 2. 閉じ括弧で始まる行は前の行の続き（「…という。」「）であるかに」「よって…」）
lines = [' ' * 16 + 'このような第三者のことを「時効完成後の第三者」という。あいうえおかきくけこ',
         ' ' * 47 + '）であるかに',
         ' ' * 16 + 'よって問題を区別する。すなわち、時効完成前の第三者に関しては当事者に該当する。']
check('閉じ括弧で始まる行と、そのあとの行を同じ段落につなぐ', in_one(lines, 'という。あいうえおかきくけこ）であるかに', 'よって問題を区別する'), True)
check('「）であるかに」が段落の先頭にならない', [p for p in build.to_paragraphs(pad() + lines) if p.startswith('）')], [])

# 3. 右端まで届かない行の次が、助詞・語尾で始まる（「暴行を加え」「たものである。」）
lines = [' ' * 16 + '第２ 前記日時場所において、Ｖ（当時２５歳）に対し、その顔面を手の甲で１回殴打し、さら',
         ' ' * 21 + 'に、その胸部を両手で押して同人を転倒させる暴行を加え',
         ' ' * 16 + 'たものである。']
check('助詞・語尾で始まる行は前の行の続き', in_one(lines, '暴行を加えたものである。', '第２ 前記日時'), True)

# 4. 見出しと本文は分ける（見出しは短いので、「この法律は…」で始まる本文とつながない）
lines = [' ' * 3 + '第１ 目的', ' ' * 16 + 'この法律は、公共交通の維持を目的とする。']
ps = build.to_paragraphs(pad() + lines)
check('見出しと、助詞で始まらない本文は別の段落', ps[-2:], ['第１ 目的', 'この法律は、公共交通の維持を目的とする。'])

# 5. 一・二・三の項目、対話の話者は新しい段落
lines = [' ' * 16 + '次の各号を提出しなければならない。', ' ' * 16 + '一 開発行為に関する計画書', ' ' * 16 + '二 設計図']
check('「一 」「二 」の項目は別の段落', build.to_paragraphs(pad() + lines)[-2:], ['一 開発行為に関する計画書', '二 設計図'])
lines = [' ' * 16 + 'Ｌ１：そうですね。それでは検討してみましょう。',
         ' ' * 18 + 'Ｐ：判例によれば、',
         ' ' * 20 + '固有必要的共同訴訟とされて',
         ' ' * 20 + 'いますから、必要があります。']
ps = build.to_paragraphs(pad() + lines)
check('対話の話者（Ｌ１：・Ｐ：）で段落を分け、発言は途中で切れない',
      ps[-2:], ['Ｌ１：そうですね。それでは検討してみましょう。', 'Ｐ：判例によれば、固有必要的共同訴訟とされていますから、必要があります。'])

print('')
if fails:
    print('❌ %d件のチェックが失敗しました' % fails)
    sys.exit(1)
print('🎉 全チェック合格')
