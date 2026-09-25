#!/usr/bin/env python3
"""Cold/warm latency benchmark against a local Ollama endpoint.

Measures what GDI's model residency policy changes in practice: the same
bounded request issued with immediate unload (keep_alive=0, the old GDI
behavior) versus a warm resident model (keep_alive>0, the new policy).
Reports load, prompt-eval, eval and total durations from Ollama's own
response metadata, so cold model loading is never blended with inference.

Usage: tools/bench-model.py [--endpoint URL] [--model NAME] [--rounds N]
       [--json PATH]  (writes one JSON document per round to stdout when no
       path is given)

This tool is read-only with respect to GDI: it talks to Ollama directly and
never changes GDI or Ollama configuration.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

QUICK_PROMPT = (
    "Correct concrete English spelling or grammar errors only. Return only "
    "JSON with keys replacement and reason. If already correct return the "
    "original text and reason none.\n\nText: I has went to the market "
    "yesterday and buy some apples.")
ASSISTANT_PROMPT = ("Answer clearly and concisely.\n\nWhat is the largest "
                    "planet in the solar system?")


def post(endpoint, path, payload, timeout=180):
    request = urllib.request.Request(
        endpoint.rstrip('/') + path,
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST')
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def ps(endpoint):
    with urllib.request.urlopen(endpoint.rstrip('/') + '/api/ps', timeout=5) as response:
        return json.loads(response.read().decode())


def one_round(endpoint, model, prompt, keep_alive, label, timeout=180):
    payload = {
        'model': model,
        'stream': False,
        'think': False,
        'keep_alive': keep_alive,
        'messages': [{'role': 'user', 'content': prompt}],
        'options': {'temperature': 0.2, 'num_ctx': 4096, 'num_predict': 128},
    }
    started = time.monotonic()
    reply = post(endpoint, '/api/chat', payload, timeout)
    total_ms = round((time.monotonic() - started) * 1000)
    return {
        'label': label,
        'model': model,
        'keep_alive': keep_alive,
        'total_ms': total_ms,
        'load_ms': round(reply.get('load_duration', 0) / 1e6),
        'prompt_eval_ms': round(reply.get('prompt_eval_duration', 0) / 1e6),
        'eval_ms': round(reply.get('eval_duration', 0) / 1e6),
        'tokens': reply.get('eval_count', 0),
        'resident_after': ps(endpoint).get('models', []),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', default='http://localhost:11434')
    parser.add_argument('--model', default='LiquidAI/lfm2.5-1.2b-instruct:q4_k_m')
    parser.add_argument('--role', choices=['quick', 'assistant'], default='quick')
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--warm-seconds', type=int, default=90)
    parser.add_argument('--json', help='write results to this file')
    args = parser.parse_args()

    prompt = QUICK_PROMPT if args.role == 'quick' else ASSISTANT_PROMPT
    results = []
    try:
        # Cold: force-unload first, then measure a keep_alive=0 request, which
        # is what GDI used to send for every request.
        post(args.endpoint, '/api/generate',
             {'model': args.model, 'keep_alive': 0}, timeout=30)
        for index in range(args.rounds):
            results.append(one_round(args.endpoint, args.model, prompt, 0,
                                     f'cold-{index + 1}'))
        # Warm: keep the model resident between rounds, the new GDI policy.
        for index in range(args.rounds):
            results.append(one_round(args.endpoint, args.model, prompt,
                                     args.warm_seconds, f'warm-{index + 1}'))
    except urllib.error.URLError as error:
        print(f'benchmark failed: {error}', file=sys.stderr)
        sys.exit(1)

    def summarize(label_prefix):
        rounds = [r for r in results if r['label'].startswith(label_prefix)]
        if not rounds:
            return None
        return {
            'mean_total_ms': round(sum(r['total_ms'] for r in rounds) / len(rounds)),
            'mean_load_ms': round(sum(r['load_ms'] for r in rounds) / len(rounds)),
            'mean_eval_ms': round(sum(r['eval_ms'] for r in rounds) / len(rounds)),
        }

    output = {'model': args.model, 'role': args.role,
              'cold': summarize('cold'), 'warm': summarize('warm'),
              'rounds': results}
    text = json.dumps(output, indent=2)
    if args.json:
        with open(args.json, 'w') as handle:
            handle.write(text)
    print(text)


if __name__ == '__main__':
    main()
