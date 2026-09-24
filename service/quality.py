"""Conservative English prose gate. Model differences alone are not evidence."""
import ctypes
import difflib
import json
import re
from router import protected_tokens


class Spelling:
    def __init__(self):
        self.lib = self.broker = self.dictionary = None
        try:
            self.lib = ctypes.CDLL('libenchant-2.so.2')
            self.lib.enchant_broker_init.restype = ctypes.c_void_p
            self.lib.enchant_broker_request_dict.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
            self.lib.enchant_broker_request_dict.restype = ctypes.c_void_p
            self.lib.enchant_dict_check.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_ssize_t]
            self.broker = self.lib.enchant_broker_init()
            self.dictionary = self.lib.enchant_broker_request_dict(self.broker, b'en_US')
        except (OSError, AttributeError):
            pass

    def valid(self, word):
        if not self.dictionary:
            return None
        encoded = word.encode()
        return self.lib.enchant_dict_check(self.dictionary, encoded, len(encoded)) == 0


SPELLING = Spelling()
COMMON = {'teh': 'the', 'recieve': 'receive', 'adress': 'address', 'occured': 'occurred',
          'seperate': 'separate', 'definately': 'definitely', 'dont': "don't", 'cant': "can't",
          'doesnt': "doesn't", 'isnt': "isn't", 'wasnt': "wasn't", 'wont': "won't",
          'its': "it's", 'theyre': "they're", 'im': "I'm", 'ive': "I've"}
AGREEMENT = [('this are', 'this is'), ('that are', 'that is'), ('it are', 'it is'),
             ('he have', 'he has'), ('she have', 'she has'), ('it have', 'it has'),
             ('we has', 'we have'), ('they has', 'they have'), ('you has', 'you have'),
             ('i has', 'I have'), ('we is', 'we are'), ('they is', 'they are'),
             ('you is', 'you are'), ('he are', 'he is'), ('she are', 'she is'),
             ('i are', 'I am'), ('i is', 'I am')]
# Auxiliary forms per subject; a swap is justified only when the new form is in
# the subject's allowed set. Multiple valid forms are accepted (have/had),
# because the gate validates the model's proposal rather than guessing one.
AUX_LEMMA = {'be': ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
             'have': ['have', 'has', 'had', 'having'],
             'do': ['do', 'does', 'did', 'done', 'doing',
                    "don't", "doesn't", "didn't"]}
SUBJECT_AUX = {'i': {'be': ['am', 'was'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]},
               'we': {'be': ['are', 'were'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]},
               'they': {'be': ['are', 'were'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]},
               'you': {'be': ['are', 'were'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]},
               'he': {'be': ['is', 'was'], 'have': ['has', 'had'], 'do': ['does', 'did', "doesn't", "didn't"]},
               'she': {'be': ['is', 'was'], 'have': ['has', 'had'], 'do': ['does', 'did', "doesn't", "didn't"]},
               'it': {'be': ['is', 'was'], 'have': ['has', 'had'], 'do': ['does', 'did', "doesn't", "didn't"]},
               'this': {'be': ['is', 'was'], 'have': ['has', 'had'], 'do': ['does', 'did', "doesn't", "didn't"]},
               'that': {'be': ['is', 'was'], 'have': ['has', 'had'], 'do': ['does', 'did', "doesn't", "didn't"]},
               'these': {'be': ['are', 'were'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]},
               'those': {'be': ['are', 'were'], 'have': ['have', 'had'], 'do': ['do', 'did', "don't", "didn't"]}}
# Common irregular verbs, keyed by lemma: (base, 3rd person, past, participle).
# Only same-lemma form changes are derivable; a different lemma is a rewrite.
VERB_LEMMAS = {
    'go': ('go', 'goes', 'went', 'gone'), 'buy': ('buy', 'buys', 'bought', 'bought'),
    'bring': ('bring', 'brings', 'brought', 'brought'), 'teach': ('teach', 'teaches', 'taught', 'taught'),
    'catch': ('catch', 'catches', 'caught', 'caught'), 'think': ('think', 'thinks', 'thought', 'thought'),
    'eat': ('eat', 'eats', 'ate', 'eaten'), 'see': ('see', 'sees', 'saw', 'seen'),
    'take': ('take', 'takes', 'took', 'taken'), 'write': ('write', 'writes', 'wrote', 'written'),
    'speak': ('speak', 'speaks', 'spoke', 'spoken'), 'do': ('do', 'does', 'did', 'done'),
    'give': ('give', 'gives', 'gave', 'given'), 'get': ('get', 'gets', 'got', 'gotten'),
    'know': ('know', 'knows', 'knew', 'known'), 'find': ('find', 'finds', 'found', 'found'),
    'tell': ('tell', 'tells', 'told', 'told'), 'feel': ('feel', 'feels', 'felt', 'felt'),
    'keep': ('keep', 'keeps', 'kept', 'kept'), 'leave': ('leave', 'leaves', 'left', 'left'),
    'meet': ('meet', 'meets', 'met', 'met'), 'pay': ('pay', 'pays', 'paid', 'paid'),
    'say': ('say', 'says', 'said', 'said'), 'sell': ('sell', 'sells', 'sold', 'sold'),
    'send': ('send', 'sends', 'sent', 'sent'), 'sit': ('sit', 'sits', 'sat', 'sat'),
    'sleep': ('sleep', 'sleeps', 'slept', 'slept'), 'spend': ('spend', 'spends', 'spent', 'spent'),
    'stand': ('stand', 'stands', 'stood', 'stood'), 'win': ('win', 'wins', 'won', 'won'),
    'drink': ('drink', 'drinks', 'drank', 'drunk'), 'drive': ('drive', 'drives', 'drove', 'driven'),
    'run': ('run', 'runs', 'ran', 'run'), 'sing': ('sing', 'sings', 'sang', 'sung'),
    'swim': ('swim', 'swims', 'swam', 'swum'), 'begin': ('begin', 'begins', 'began', 'begun'),
    'break': ('break', 'breaks', 'broke', 'broken'), 'choose': ('choose', 'chooses', 'chose', 'chosen'),
    'forget': ('forget', 'forgets', 'forgot', 'forgotten'), 'ride': ('ride', 'rides', 'rode', 'ridden'),
    'wear': ('wear', 'wears', 'wore', 'worn'),
}
FORM_NAMES = ('base', '3sg', 'past', 'participle')
PAST_MARKERS = re.compile(r'\b(?:yesterday|ago|last|previously|earlier|then|already|later|'
                          r'after|before|in\s+(?:19|20)\d\d)\b', re.I)
VERB_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")


def _subject_forms(word):
    """Auxiliary forms allowed for a subject word; None when it cannot be judged."""
    subject = SUBJECT_AUX.get(word)
    if subject:
        return subject
    if not word or not word.isalpha() or len(word) < 3:
        return None
    if word.endswith('s') and not word.endswith(('ss', 'us', 'is')):
        return SUBJECT_AUX['they']
    return SUBJECT_AUX['he']


def _pluralish(word):
    forms = _subject_forms(word)
    return bool(forms and forms is SUBJECT_AUX['they'])


def _aux_agreement(old, new, preceding):
    """Same auxiliary lemma, with the new form valid for the subject and the old not."""
    old_form, new_form = old.lower(), new.lower()
    if old_form == new_form:
        return False
    for lemma, forms in AUX_LEMMA.items():
        if old_form in forms and new_form in forms:
            allowed = _subject_forms(preceding)
            return bool(allowed and new_form in allowed.get(lemma, []) and
                        old_form not in allowed.get(lemma, []))
    return False


def _verb_lookup(word):
    """Return (lemma, form-name) when the word is an irregular verb form."""
    w = word.lower()
    for lemma, forms in VERB_LEMMAS.items():
        if w in forms:
            return lemma, FORM_NAMES[forms.index(w)]
    return None


# Past evidence must be local to the corrected word, not anywhere in the
# sentence: 'yesterday' after the verb does not justify a tense change.
LOCAL_PAST_MARKERS = {'yesterday', 'ago', 'last', 'previously', 'earlier'}


def _past_evidence(words, position):
    for word in words[max(0, position - 4):position]:
        if word.lower().strip(".,;:!?") in LOCAL_PAST_MARKERS:
            return True
    for word in reversed(words[max(0, position - 10):position]):
        entry = _verb_lookup(word)
        if entry:
            return entry[1] == 'past'
    return False


def _deletable_aux(words, position):
    """A wrongly-agreed 'has/have' before a past verb may drop to simple past."""
    word = words[position].lower()
    if word not in ('has', 'have'):
        return False
    preceding = words[position - 1].lower() if position > 0 else ''
    subject = _subject_forms(preceding)
    if not subject or word in subject['have']:
        return False
    following = _verb_lookup(words[position + 1]) if position + 1 < len(words) else None
    return bool(following and following[1] == 'past')


def _verb_form_change(old, new, preceding, words, position):
    """Same-lemma irregular verb form fix with a local grammatical justification."""
    old_entry, new_entry = _verb_lookup(old), _verb_lookup(new)
    if not old_entry or not new_entry or old_entry[0] != new_entry[0] or old.lower() == new.lower():
        return False
    form = new_entry[1]
    if form == 'participle':
        # Participle is required after an auxiliary: has went -> has gone.
        return preceding in ('have', 'has', 'had', "'d", 'is', 'are', 'was', 'were',
                             'am', 'be', 'been', 'being', 'get', 'gets', 'got')
    if form == 'past':
        if old_entry[1] == 'participle':
            # A finite participle ('I seen him') is always wrong; simple past
            # is the only fix. Never rewrite a participle that follows an aux.
            return preceding not in ('have', 'has', 'had')
        # Past tense only with local past evidence: ... yesterday and buy -> bought.
        return _past_evidence(words, position)
    if form == '3sg':
        return old_entry[1] == 'base' and not _pluralish(preceding)
    if form == 'base':
        return old_entry[1] == '3sg' and _pluralish(preceding)
    return False


def candidate(nearby, start_offset):
    """Last completed sentence only; never an arbitrary document prefix."""
    stripped = nearby.rstrip()
    if not stripped or stripped[-1] not in '.!?':
        return None
    boundary = max(stripped.rfind('\n'), max((m.end() for m in re.finditer(r'[.!?]\s+', stripped[:-1])), default=0))
    source = stripped[boundary:].lstrip()
    start = start_offset + len(stripped) - len(source)
    if not 16 <= len(source) <= 280 or len(source.split()) < 4:
        return None
    if any(marker in source for marker in ('```', '=>', '://', '{', '}', '<', '>', '\t', '\ufffc')):
        return None
    # A clipped sentence from a long line is not a safe source.
    if boundary == 0 and start_offset > 0:
        return None
    words = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", source)
    known = [SPELLING.valid(word) for word in words]
    if known and None not in known and sum(known) / len(known) < .65:
        return None
    return (start, source) if worth_checking(source) else None


def worth_checking(text):
    if any(re.search(r'\b' + before + r'\b', text, re.I) for before, _ in AGREEMENT):
        return True
    if re.search(r'\b([A-Za-z]+)\s+\1\b', text, re.I) or re.search(r'\bi\b', text):
        return True
    # Auxiliary followed by a past form instead of a participle: has went, have
    # wrote. Base/3sg forms next to an explicit past marker also merit a check.
    if re.search(r'\b(?:have|has|had)\s+(?:went|came|saw|did|took|gave|ate|wrote|spoke|'
                 r'drank|swam|began|broke|chose|drove|rode|ran|sang|forgot|bought|brought)\b',
                 text, re.I):
        return True
    if PAST_MARKERS.search(text) and re.search(
            r'\b(?:went|ate|saw|took|gave|bought|did|came|got|made|said|found|told|'
            r'felt|kept|left|met|paid|sold|sent|thought|brought|taught|caught)\b', text, re.I):
        return True
    if text[0].islower():
        return True
    return any(word in COMMON or (len(word) >= 4 and word.islower() and SPELLING.valid(word) is False)
               for word in VERB_WORD.findall(text))


def quality(source, response):
    """Return only a validated, local correction and its non-text category."""
    try:
        item = json.loads(response)
        suggestion, reason = item['replacement'], item['reason']
        if not isinstance(suggestion, str) or reason not in ('grammar', 'spelling', 'punctuation'):
            return None
    except (ValueError, KeyError, TypeError):
        return None
    if (source.strip() == suggestion.strip() or re.sub(r'\s+', '', source) == re.sub(r'\s+', '', suggestion)
            or '\n' in suggestion or not .75 <= len(suggestion) / len(source) <= 1.25
            or protected_tokens(source) != protected_tokens(suggestion)
            or re.findall(r'\d+', source) != re.findall(r'\d+', suggestion)):
        return None
    # Construct only provable local improvements, not tone/verbosity preferences.
    # Subject/aux agreement is derived from the word diff itself, so any valid
    # form the model chooses (have/had) is judged, not one pre-guessed answer.
    allowed = source
    categories = []
    # Repeated function words such as 'had had' and 'that that' can be valid.
    updated = re.sub(r'\b(the|a|an|to)\s+\1\b', r'\1', allowed, flags=re.I)
    if updated != allowed:
        categories.append('repeated-word'); allowed = updated
    source_words = VERB_WORD.findall(allowed)
    proposed_words = VERB_WORD.findall(suggestion)
    matcher = difflib.SequenceMatcher(None, source_words, proposed_words, autojunk=False)
    replacements = {}
    deleted = False

    def judge(old, new, position):
        preceding = source_words[position - 1].lower() if position > 0 else ''
        if old == 'i' and new == 'I' or (position == 0 and old[0].islower() and new == old.capitalize()):
            categories.append('capitalization')
        elif COMMON.get(old.lower()) == new.lower():
            categories.append('spelling')
        elif _aux_agreement(old, new, preceding):
            categories.append('agreement')
        elif _verb_form_change(old, new, preceding, source_words, position):
            categories.append('verb-form')
        elif (old.islower() and new.islower() and len(old) >= 4 and
              SPELLING.valid(old) is False and SPELLING.valid(new) is True and
              difflib.SequenceMatcher(None, old, new).ratio() >= .7):
            categories.append('spelling')
        else:
            return False
        return True

    for kind, a, b, c, d in matcher.get_opcodes():
        if kind == 'equal':
            continue
        # Adjacent one-word fixes surface as one n:n replace block; judge each
        # word pair independently and keep positions aligned.
        if kind == 'replace' and (b - a) == (d - c):
            for offset in range(b - a):
                old, new = source_words[a + offset], proposed_words[c + offset]
                if not judge(old, new, a + offset):
                    return None
                replacements[a + offset] = new
            continue
        # A wrongly agreed auxiliary can drop out before a past verb.
        if kind == 'delete' and (b - a) == 1 and _deletable_aux(source_words, a):
            categories.append('agreement')
            replacements[a] = ''
            deleted = True
            continue
        return None
    index = -1
    def corrected(match):
        nonlocal index
        index += 1
        return replacements.get(index, match[0])
    allowed = VERB_WORD.sub(corrected, allowed)
    if deleted:
        allowed = re.sub(r'(?<=\S) {2,}(?=\S)', ' ', allowed)
    if allowed != suggestion or not categories or len(categories) > 3:
        return None
    # Display the exact changed span, with a few words of local context.
    prefix = 0
    while prefix < min(len(source), len(suggestion)) and source[prefix] == suggestion[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(len(source), len(suggestion)) - prefix and source[-1-suffix] == suggestion[-1-suffix]:
        suffix += 1
    left = source.rfind(' ', 0, max(0, prefix - 8)) + 1
    old_end, new_end = len(source) - suffix, len(suggestion) - suffix
    tail = source.find(' ', min(len(source), old_end + 8))
    tail = len(source) if tail < 0 else tail
    before = source[left:tail]
    after = suggestion[left:new_end + tail - old_end]
    if max(len(before), len(after)) > 140:
        return None
    # Key repeated correction preferences to the changed words, not the sentence.
    word_start = source.rfind(' ', 0, prefix) + 1
    pattern_start = source.rfind(' ', 0, max(0, word_start - 1)) + 1
    word_end = source.find(' ', old_end)
    word_end = len(source) if word_end < 0 else word_end
    return {'pattern_before': source[pattern_start:word_end],
            'pattern_after': suggestion[pattern_start:new_end + word_end - old_end],
            'replacement': suggestion, 'category': '+'.join(sorted(set(categories))),
            'before': before, 'after': after, 'larger': max(len(before), len(after)) > 70}
