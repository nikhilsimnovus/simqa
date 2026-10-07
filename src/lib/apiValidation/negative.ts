// Negative test cases derived from the documented error responses of each API.
//
// Nothing here invents an error: a case is only generated when the document
// lists that status code for that API, and the case is built to provoke
// exactly the reason the code is documented for. That is what lets the runner
// insist on 404 for an unknown ID and reject a 400 in its place.
//
// Ported from negative.py.

import type { Json, Spec, SpecOp } from './spec.ts';

export const WRONG_TYPE: Record<string, Json> = {
  string: 12345,
  integer: 'not-a-number',
  number: 'not-a-number',
  boolean: 'not-a-boolean',
  array: 'not-an-array',
  object: 'not-an-object',
};

/** An ID that is well formed per the schema but cannot exist. */
export function sentinel(schema: Json): Json {
  if (schema?.type === 'integer') return 987654321;
  if (schema?.format === 'uuid') return '00000000-0000-4000-8000-00000000dead';
  return 'sat-nonexistent-0000';
}

export const SENTINELS = new Set(
  [{ type: 'integer' }, { format: 'uuid' }, {}].map(s => String(sentinel(s))),
);

/** One planned request. `kind` separates the real call from the cases that
 *  are expected to fail. */
export interface Case {
  name: string;
  /** 'setup' is the runner's own calls — logins, the temporary user,
   *  clean-up deletes — which are never graded as negatives. */
  kind: 'positive' | 'negative' | 'setup';
  expect?: string[];
  path: Record<string, Json>;
  query: Record<string, Json>;
  body: Json;
  rawBody?: string;
  files?: Json;
  auth?: 'none' | 'bad' | 'limited';
  exampleName?: string;
}

/** Top-level properties and required list of a body schema, merging allOf. */
function propertiesOf(spec: Spec, schema: Json): [Record<string, Json>, string[]] {
  const s = spec.resolve(schema) ?? {};
  const props: Record<string, Json> = { ...(s.properties ?? {}) };
  let required: string[] = [...(s.required ?? [])];
  for (const part of s.allOf ?? []) {
    const [p, r] = propertiesOf(spec, part);
    Object.assign(props, p);
    required = [...required, ...r];
  }
  return [props, required];
}

/** (path, value) of every scalar inside a body; lists contribute their first item. */
function* leaves(value: Json, path: Array<string | number> = []): Generator<[Array<string | number>, Json]> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) yield* leaves(v, [...path, k]);
  } else if (Array.isArray(value)) {
    if (value.length) yield* leaves(value[0], [...path, 0]);
  } else {
    yield [path, value];
  }
}

function withValue(body: Json, path: Array<string | number>, next: Json): Json {
  const out = structuredClone(body);
  let node = out;
  for (const step of path.slice(0, -1)) node = node[step];
  node[path[path.length - 1]] = next;
  return out;
}

function show(path: Array<string | number>): string {
  return path.map(p => (typeof p === 'number' ? `[${p}]` : p)).join('/').replace(/\/\[/g, '[');
}

export function cases(spec: Spec, op: SpecOp, positive: Case, limitedUser: boolean, nested = false): Case[] {
  const codes = op.responses;
  const out: Case[] = [];
  const add = (name: string, code: string, changes: Partial<Case>): void => {
    out.push({ ...structuredClone(positive), name, kind: 'negative', expect: [code], ...changes });
  };

  const body = positive.body;
  const isObject = body && typeof body === 'object' && !Array.isArray(body);

  if ('401' in codes) {
    if (op.secured) {
      add('No bearer token', '401', { auth: 'none' });
      add('Invalid bearer token', '401', { auth: 'bad' });
    } else if (isObject && 'password' in body) {
      add('Wrong password', '401', { body: { ...body, password: `${body.password}-wrong` } });
    }
  }

  if ('403' in codes && op.adminOnly && limitedUser) {
    add('Non-admin user calls admin-only API', '403', { auth: 'limited' });
  }

  const pathParams = op.params.filter(p => p.in === 'path');
  if ('404' in codes && pathParams.length) {
    const path: Record<string, Json> = {};
    for (const p of pathParams) path[p.name] = sentinel(p.schema);
    add('Unknown ID in path', '404', { path });
  }

  if ('400' in codes) {
    // Top-level fields only; nested mutations add little and multiply run
    // time. Body mutations are skipped for DELETE so a lenient server can
    // never widen what gets deleted.
    if (isObject && op.method !== 'delete' && op.body?.contentType.includes('json')) {
      const [props, required] = propertiesOf(spec, op.body.schema);
      for (const name of required) {
        if (name in body) {
          const trimmed = { ...body };
          delete trimmed[name];
          add(`Missing required field '${name}'`, '400', { body: trimmed });
        }
      }
      for (const [name, rawPs] of Object.entries(props)) {
        const ps = spec.resolve(rawPs) ?? {};
        if (!(name in body)) continue;
        if (ps.type in WRONG_TYPE) {
          add(`Wrong type for '${name}' (expects ${ps.type})`, '400', { body: { ...body, [name]: WRONG_TYPE[ps.type] } });
        }
        if (ps.enum) {
          add(`Value outside enum for '${name}'`, '400', { body: { ...body, [name]: 'SAT_INVALID_ENUM' } });
        }
        if ('maxLength' in ps) {
          add(`'${name}' longer than maxLength ${ps.maxLength}`, '400', { body: { ...body, [name]: 'x'.repeat(ps.maxLength + 1) } });
        }
        if ('minimum' in ps) {
          add(`'${name}' below minimum ${ps.minimum}`, '400', { body: { ...body, [name]: ps.minimum - 1 } });
        }
        if ('maximum' in ps) {
          add(`'${name}' above maximum ${ps.maximum}`, '400', { body: { ...body, [name]: ps.maximum + 1 } });
        }
      }
      add('Malformed JSON body', '400', { body: null, rawBody: '{"sat-malformed": ' });

      if (nested) {
        // Deep configuration bodies (test-creation): break a value inside them too.
        const all = [...leaves(body)];
        const number = all.find(([, v]) => typeof v === 'number');
        const flag = all.find(([, v]) => typeof v === 'boolean');
        const rat = all.find(([p]) => p.length && p[p.length - 1] === 'ratType');
        const plan: Array<[typeof number, string, Json]> = [
          [number, 'Wrong type in nested field', 'not-a-number'],
          [flag, 'Wrong type in nested field', 'not-a-boolean'],
          [rat, 'Invalid value for nested field', 'SAT_INVALID_RAT'],
        ];
        for (const [found, name, bad] of plan) {
          if (found) add(`${name} '${show(found[0])}'`, '400', { body: withValue(body, found[0], bad) });
        }
      }
    }
    for (const p of op.params) {
      if (p.in !== 'query') continue;
      const s = p.schema ?? {};
      const q = positive.query;
      if (s.type === 'integer' || s.type === 'number') {
        add(`Query '${p.name}' is not a number`, '400', { query: { ...q, [p.name]: 'not-a-number' } });
      }
      if ('minimum' in s) {
        add(`Query '${p.name}' below minimum ${s.minimum}`, '400', { query: { ...q, [p.name]: s.minimum - 1 } });
      }
      if ('maximum' in s) {
        add(`Query '${p.name}' above maximum ${s.maximum}`, '400', { query: { ...q, [p.name]: s.maximum + 1 } });
      }
      if (s.enum) {
        add(`Query '${p.name}' outside enum`, '400', { query: { ...q, [p.name]: 'SAT_INVALID_ENUM' } });
      }
    }
  }
  return out;
}

/** Re-send a successful create; the document lists 409 for it. */
export function duplicate(positive: Case): Case {
  return { ...structuredClone(positive), name: 'Duplicate create (same payload again)', kind: 'negative', expect: ['409'] };
}
