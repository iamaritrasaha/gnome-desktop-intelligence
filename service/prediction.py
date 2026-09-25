"""Predictive writing quality gate. A model producing text is not a suggestion.

The gate accepts only a short, useful continuation of the text the user already
wrote: no echoes of existing words, no commentary, no Markdown syntax, no
protected-literal corruption, and no oversized output. Everything else is
suppressed before it can reach the user's visual field.
"""

import re

MAX_PREDICTION_CHARS = 160
MAX_SOURCE_CHARS = 320
MIN_SOURCE_CHARS = 30
MIN_SOURCE_WORDS = 6
MIN_WORDS = 2
MAX_WORDS = 28

# One-word continuations are almost never worth interrupting for.
TRIVIAL_WORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'is',
    'it', 'its', "it's", 'that', 'this', 'for', 'with', 'as', 'by', 'be',
    'are', 'was', 'were', 'has', 'have', 'had', 'so', 'if', 'we', 'they',
    'you', 'i', 'my', 'our', 'their', 'not', 'no', 'yes',
}

# Models occasionally answer instead of continuing. These openings are
# commentary, not prose the user would have typed next.
COMMENTARY = re.compile(
    r"^(?:sure|okay|ok|here(?:'s| is)|note that|continuation|prediction|next:|"
    r"assistant|response|answer|as an ai|i cannot|i'm sorry|sorry)\b", re.I)

# Prose prediction never produces Markdown; its syntax is corruption here.
MARKDOWN_CHARS = re.compile(r"[`*_#\[\]>~|]")

CODE_MARKERS = ('```', '://', '{', '}', '<', '>', '\t', '\ufffc', '=>')

WORD = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?")


def prediction_source(nearby):
    """The bounded text before the caret, or '' when it cannot support a
    useful prediction (too little context, code-like content)."""
    source = (nearby or '').rstrip('\n')[-MAX_SOURCE_CHARS:]
    if len(source.strip()) < MIN_SOURCE_CHARS:
        return ''
    if any(marker in source for marker in CODE_MARKERS):
        return ''
    trailing = source[-200:]
    if len(WORD.findall(trailing)) < MIN_SOURCE_WORDS:
        return ''
    if not WORD.search(source):
        return ''
    return source


def clean_prediction(source, response):
    """Normalize and gate a raw model continuation. Returns the continuation
    with correct leading whitespace, or '' when it must be suppressed."""
    if isinstance(response, dict):
        response = response.get('continuation', '')
    if not isinstance(response, str):
        return ''
    text = response.strip()
    if not text or len(text) > MAX_PREDICTION_CHARS:
        return ''
    # Unparsed JSON defensively rejected: the router parses structured
    # responses before this gate, so braces here mean a malformed pipeline.
    if text[0] in '{[' or '"continuation"' in text:
        return ''
    # A continuation never spans paragraphs or announces itself.
    text = text.splitlines()[0].strip()
    if not text:
        return ''
    if COMMENTARY.match(text) or MARKDOWN_CHARS.search(text):
        return ''
    if len(WORD.findall(text)) < MIN_WORDS or len(WORD.findall(text)) > MAX_WORDS:
        return ''
    words = WORD.findall(text)
    if len(words) == 1 and words[0].lower() in TRIVIAL_WORDS:
        return ''
    # Repeated existing text: any 4-word run of the continuation that already
    # appears in the source means the model echoed the user, not continued.
    source_words = [w.lower() for w in WORD.findall(source)]
    if len(words) >= 4:
        joined = ' ' + ' '.join(source_words) + ' '
        for index in range(len(words) - 3):
            if ' ' + ' '.join(w.lower() for w in words[index:index + 4]) + ' ' in joined:
                return ''
    # An echo of the source's final words (even one repeated word) is not a
    # prediction of what comes next.
    lower = text.lower()
    if source_words and words and words[0].lower() == source_words[-1]:
        return ''
    for n in range(min(4, len(source_words) - 1), 1, -1):
        if ' '.join(source_words[-n:]) in lower[:len(' '.join(source_words[-n:])) + 1]:
            return ''
    # Whitespace normalization: the continuation continues the exact source.
    if source and source[-1].isspace():
        text = text.lstrip()
    elif not source or not text[0].isspace():
        text = ' ' + text
    # Protected literals must never appear mutated or new in a prediction.
    from router import protected_tokens
    if protected_tokens(text):
        return ''
    return text


def prediction_worth_showing(source, continuation):
    """Final usefulness decision: suppress anything that would not justify
    drawing the user's attention to it."""
    return bool(clean_prediction(source, continuation))
