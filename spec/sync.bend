import Base

type Key is Data:
  RowKey{table: Nat, id: Nat}

def Key.eq(+a: Key, +b: Key) -> Bool:
  match a b:
    case RowKey{at, ai} RowKey{bt, bi}:
      Bool.and(Nat.is_eq(at, bt), Nat.is_eq(ai, bi))

# (table, id) order: the order of a snapshot and its pages
def Key.lt(+a: Key, +b: Key) -> Bool:
  match a b:
    case RowKey{at, ai} RowKey{bt, bi}:
      Bool.or(Nat.is_lt(at, bt), Bool.and(Nat.is_eq(at, bt), Nat.is_lt(ai, bi)))

# assoc list keyed by Nat: columns of a row, client seqs
type NMap<-V: Data> is Data:
  NNil{}
  NCon{key: Nat, val: V, rest: NMap<V>}

def NMap.if(-V: Data, yes: V, no: V, hit: Bool) -> V:
  match hit:
    case True{}:
      yes
    case False{}:
      no

def NMap.get(-V: Data, m: NMap<V>, +k: Nat, +d: V) -> V:
  match m:
    case NNil{}:
      d
    case NCon{+key, val, rest}:
      NMap.if(V, val, NMap.get(V, rest, k, d), Nat.is_eq(key, k))

def NMap.lookup(-V: Data, m: NMap<V>, +k: Nat) -> Maybe<&2, V>:
  match m:
    case NNil{}:
      None{}
    case NCon{+key, val, rest}:
      NMap.if(Maybe<&2, V>, Some{val}, NMap.lookup(V, rest, k), Nat.is_eq(key, k))

def NMap.set(-V: Data, m: NMap<V>, +k: Nat, +v: V) -> NMap<V>:
  match m:
    case NNil{}:
      NCon{k, v, NNil{}}
    case NCon{+key, +val, +rest}:
      NMap.if(NMap<V>, NCon{key, v, rest}, NCon{key, val, NMap.set(V, rest, k, v)}, Nat.is_eq(key, k))

# right-biased merge: every column of patch overrides row
def NMap.merge(-V: Data, patch: NMap<V>, row: NMap<V>) -> NMap<V>:
  match patch:
    case NNil{}:
      row
    case NCon{key, val, rest}:
      NMap.merge(V, rest, NMap.set(V, row, key, val))

# assoc list keyed by Key: rows, changes
type KMap<-V: Data> is Data:
  KNil{}
  KCon{key: Key, val: V, rest: KMap<V>}

def KMap.if(-V: Data, yes: V, no: V, hit: Bool) -> V:
  match hit:
    case True{}:
      yes
    case False{}:
      no

def KMap.get(-V: Data, m: KMap<V>, +k: Key, +d: V) -> V:
  match m:
    case KNil{}:
      d
    case KCon{+key, val, rest}:
      KMap.if(V, val, KMap.get(V, rest, k, d), Key.eq(key, k))

def KMap.lookup(-V: Data, m: KMap<V>, +k: Key) -> Maybe<&2, V>:
  match m:
    case KNil{}:
      None{}
    case KCon{+key, val, rest}:
      KMap.if(Maybe<&2, V>, Some{val}, KMap.lookup(V, rest, k), Key.eq(key, k))

def KMap.set(-V: Data, m: KMap<V>, +k: Key, +v: V) -> KMap<V>:
  match m:
    case KNil{}:
      KCon{k, v, KNil{}}
    case KCon{+key, +val, +rest}:
      KMap.if(KMap<V>, KCon{key, v, rest}, KCon{key, val, KMap.set(V, rest, k, v)}, Key.eq(key, k))

def KMap.del(-V: Data, m: KMap<V>, +k: Key) -> KMap<V>:
  match m:
    case KNil{}:
      KNil{}
    case KCon{+key, +val, +rest}:
      KMap.if(KMap<V>, KMap.del(V, rest, k), KCon{key, val, KMap.del(V, rest, k)}, Key.eq(key, k))

def KMap.put(-V: Data, m: KMap<V>, +k: Key, mv: Maybe<&2, V>) -> KMap<V>:
  match mv:
    case None{}:
      KMap.del(V, m, k)
    case Some{v}:
      KMap.set(V, m, k, v)

type Row is Data:
  Row{cols: NMap<Nat>}

type Op is Data:
  Put{row: NMap<Nat>}
  Patch{cols: NMap<Nat>}
  Delete{}

type Write is Data:
  Write{client: Nat, seq: Nat, op: Op, table: Nat, id: Nat}

type State is Data:
  State{rows: KMap<NMap<Nat>>, head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, horizon: Nat}

def State.head(s: State) -> Nat:
  match s:
    case State{rows, head, changes, clients, horizon}:
      head

def State.rows(s: State) -> KMap<NMap<Nat>>:
  match s:
    case State{rows, head, changes, clients, horizon}:
      rows

def State.changes(s: State) -> KMap<Nat>:
  match s:
    case State{rows, head, changes, clients, horizon}:
      changes

def State.clients(s: State) -> NMap<Nat>:
  match s:
    case State{rows, head, changes, clients, horizon}:
      clients

def State.horizon(s: State) -> Nat:
  match s:
    case State{rows, head, changes, clients, horizon}:
      horizon

def Write.seq(w: Write) -> Nat:
  match w:
    case Write{client, seq, op, table, id}:
      seq

# an applied write bumps head and stamps the key
def touch(rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, horizon: Nat, +key: Key) -> State:
  State{rows, 1n+head, KMap.set(Nat, changes, key, 1n+head), clients, horizon}

def apply.patch(cur: Maybe<&2, NMap<Nat>>, cols: NMap<Nat>, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, horizon: Nat) -> State:
  match cur:
    case None{}:
      State{rows, head, changes, clients, horizon}
    case Some{row}:
      touch(KMap.set(NMap<Nat>, rows, key, NMap.merge(Nat, cols, row)), head, changes, clients, horizon, key)

def apply.row(op: Op, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, horizon: Nat) -> State:
  match op:
    case Put{row}:
      touch(KMap.set(NMap<Nat>, rows, key, row), head, changes, clients, horizon, key)
    case Patch{cols}:
      apply.patch(KMap.lookup(NMap<Nat>, rows, key), cols, key, rows, head, changes, clients, horizon)
    case Delete{}:
      touch(KMap.del(NMap<Nat>, rows, key), head, changes, clients, horizon, key)

def apply.go(skip: Bool, op: Op, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, horizon: Nat, +client: Nat, +seq: Nat) -> State:
  match skip:
    case True{}:
      State{rows, head, changes, clients, horizon}
    case False{}:
      apply.row(op, key, rows, head, changes, NMap.set(Nat, clients, client, seq), horizon)

def apply(s: State, w: Write) -> State:
  match s w:
    case State{+rows, +head, changes, +clients, horizon} Write{+client, +seq, op, table, id}:
      apply.go(Nat.is_le(seq, NMap.get(Nat, clients, client, 0n)), op, RowKey{table, id}, rows, head, changes, clients, horizon, client, seq)

# the same write with the replay guard off: what apply does to a write it has not seen
def apply.force(s: State, w: Write) -> State:
  match s w:
    case State{rows, head, changes, clients, horizon} Write{client, seq, op, table, id}:
      apply.go(False{}, op, RowKey{table, id}, rows, head, changes, clients, horizon, client, seq)

# a batch: sorted by seq, then applied one by one
def insert(+w: Write, ws: List<&2, Write>) -> List<&2, Write>:
  match ws:
    case Nil{}:
      [w]
    case Con{+x, +rest}:
      KMap.if(List<&2, Write>, w <> (x <> rest), x <> insert(w, rest), Nat.is_lt(Write.seq(w), Write.seq(x)))

def sortBySeq(ws: List<&2, Write>) -> List<&2, Write>:
  match ws:
    case Nil{}:
      Nil{}
    case Con{w, rest}:
      insert(w, sortBySeq(rest))

def applyAll(ws: List<&2, Write>, s: State) -> State:
  match ws:
    case Nil{}:
      s
    case Con{w, rest}:
      applyAll(rest, apply(s, w))

def applyForce(ws: List<&2, Write>, s: State) -> State:
  match ws:
    case Nil{}:
      s
    case Con{w, rest}:
      applyForce(rest, apply.force(s, w))

def applyBatch(s: State, ws: List<&2, Write>) -> State:
  applyAll(sortBySeq(ws), s)

# a batch from client c whose seqs climb strictly from above n: a fresh outbox once sorted
def Asc(ws: List<&2, Write>, +n: Nat, +c: Nat) -> Bool:
  match ws:
    case Nil{}:
      True{}
    case Con{Write{client, +seq, op, table, id}, rest}:
      Bool.and(Bool.and(Nat.is_eq(client, c), Nat.is_gt(seq, n)), Asc(rest, seq, c))

def lastSeq(ws: List<&2, Write>, n: Nat) -> Nat:
  match ws:
    case Nil{}:
      n
    case Con{Write{client, seq, op, table, id}, rest}:
      lastSeq(rest, seq)

# compaction forgets tombstone stamps at or below the horizon; a key that still has a row keeps its stamp
def compact.go(changes: KMap<Nat>, +rows: KMap<NMap<Nat>>, +h: Nat) -> KMap<Nat>:
  match changes:
    case KNil{}:
      KNil{}
    case KCon{+key, +stamp, rest}:
      +tail = compact.go(rest, rows, h)
      KMap.if(KMap<Nat>, tail, KCon{key, stamp, tail}, Bool.and(Nat.is_le(stamp, h), Maybe.is_none(&2, NMap<Nat>, KMap.lookup(NMap<Nat>, rows, key))))

def compact(s: State, +h: Nat) -> State:
  match s:
    case State{+rows, head, changes, clients, +horizon}:
      State{rows, head, compact.go(changes, rows, Nat.max(horizon, h)), clients, Nat.max(horizon, h)}

# pull: every key stamped after cursor, with its current row (None when deleted)
type Pulled is Data:
  Pulled{key: Key, row: Maybe<&2, NMap<Nat>>}

def pull.go(changes: KMap<Nat>, +rows: KMap<NMap<Nat>>, +cursor: Nat) -> List<&2, Pulled>:
  match changes:
    case KNil{}:
      Nil{}
    case KCon{+key, stamp, rest}:
      +tail = pull.go(rest, rows, cursor)
      KMap.if(List<&2, Pulled>, Pulled{key, KMap.lookup(NMap<Nat>, rows, key)} <> tail, tail, Nat.is_gt(stamp, cursor))

type Pull is Data:
  Snapshot{rows: KMap<NMap<Nat>>, head: Nat}
  Delta{items: List<&2, Pulled>, head: Nat}

def Pull.head(p: Pull) -> Nat:
  match p:
    case Snapshot{rows, head}:
      head
    case Delta{items, head}:
      head

def pull.pick(snap: Bool, rows: KMap<NMap<Nat>>, head: Nat, changes: KMap<Nat>, +cursor: Nat) -> Pull:
  match snap:
    case True{}:
      Snapshot{rows, head}
    case False{}:
      Delta{pull.go(changes, rows, cursor), head}

# cursor 0, or a cursor below the horizon whose tombstones may be gone, gets the rows themselves
def pull(s: State, +cursor: Nat) -> Pull:
  match s:
    case State{rows, head, changes, clients, horizon}:
      pull.pick(Bool.or(Nat.is_eq(cursor, 0n), Nat.is_lt(cursor, horizon)), rows, head, changes, cursor)

type Client is Data:
  Client{local: KMap<NMap<Nat>>, cursor: Nat}

def Client.local(c: Client) -> KMap<NMap<Nat>>:
  match c:
    case Client{local, cursor}:
      local

def Client.cursor(c: Client) -> Nat:
  match c:
    case Client{local, cursor}:
      cursor

def applyPull.go(items: List<&2, Pulled>, local: KMap<NMap<Nat>>) -> KMap<NMap<Nat>>:
  match items:
    case Nil{}:
      local
    case Con{Pulled{key, row}, rest}:
      applyPull.go(rest, KMap.put(NMap<Nat>, local, key, row))

def applyPull(c: Client, p: Pull) -> Client:
  match c p:
    case Client{local, cursor} Snapshot{rows, head}:
      Client{rows, head}
    case Client{local, cursor} Delta{items, head}:
      Client{applyPull.go(items, local), head}

# a snapshot page: the n smallest keys above `after` that have a row, and the key to continue after, if any
type Page is Data:
  Page{items: List<&2, Pulled>, next: Maybe<&2, Key>, head: Nat}

def above(+after: Maybe<&2, Key>, +key: Key) -> Bool:
  match after:
    case None{}:
      True{}
    case Some{a}:
      Key.lt(a, key)

def pullPage.better(cand: Pulled, best: Maybe<&2, Pulled>) -> Maybe<&2, Pulled>:
  match cand best:
    case Pulled{+ck, cr} None{}:
      Some{Pulled{ck, cr}}
    case Pulled{+ck, cr} Some{Pulled{+bk, br}}:
      KMap.if(Maybe<&2, Pulled>, Some{Pulled{ck, cr}}, Some{Pulled{bk, br}}, Bool.not(Key.lt(bk, ck)))

def pullPage.min(rows: KMap<NMap<Nat>>, +after: Maybe<&2, Key>) -> Maybe<&2, Pulled>:
  match rows:
    case KNil{}:
      None{}
    case KCon{+key, row, rest}:
      +tail = pullPage.min(rest, after)
      KMap.if(Maybe<&2, Pulled>, pullPage.better(Pulled{key, Some{row}}, tail), tail, above(after, key))

def pullPage.go(n: Nat, +rows: KMap<NMap<Nat>>, hit: Maybe<&2, Pulled>) -> List<&2, Pulled>:
  match n:
    case 0n:
      Nil{}
    case 1n+p:
      match hit:
        case None{}:
          Nil{}
        case Some{Pulled{+key, row}}:
          Pulled{key, row} <> pullPage.go(p, rows, pullPage.min(rows, Some{key}))

def pullPage.last(items: List<&2, Pulled>, +k: Key, +rows: KMap<NMap<Nat>>) -> Maybe<&2, Key>:
  match items:
    case Nil{}:
      KMap.if(Maybe<&2, Key>, Some{k}, None{}, Maybe.is_some(&2, Pulled, pullPage.min(rows, Some{k})))
    case Con{Pulled{key, row}, rest}:
      pullPage.last(rest, key, rows)

def pullPage.wrap(items: List<&2, Pulled>, +rows: KMap<NMap<Nat>>, head: Nat) -> Page:
  match items:
    case Nil{}:
      Page{Nil{}, None{}, head}
    case Con{Pulled{+key, row}, +rest}:
      Page{Pulled{key, row} <> rest, pullPage.last(rest, key, rows), head}

def pullPage(s: State, +after: Maybe<&2, Key>, n: Nat) -> Page:
  match s:
    case State{+rows, head, changes, clients, horizon}:
      pullPage.wrap(pullPage.go(n, rows, pullPage.min(rows, after)), rows, head)

# the client outbox: one entry per trigger, coalesced into one write per key at push time
type EOp is Data:
  Inserted{}
  Updated{col: Nat}
  Deleted{}

type Entry is Data:
  Entry{seq: Nat, table: Nat, id: Nat, op: EOp}

type Group is Data:
  Group{key: Key, seq: Nat, inserted: Bool, last: EOp, cols: List<&2, Nat>}

def Group.key(g: Group) -> Key:
  match g:
    case Group{key, seq, inserted, last, cols}:
      key

def cols.add(cols: List<&2, Nat>, +c: Nat) -> List<&2, Nat>:
  match cols:
    case Nil{}:
      [c]
    case Con{+h, +t}:
      KMap.if(List<&2, Nat>, h <> t, h <> cols.add(t, c), Nat.is_eq(h, c))

def Group.note(g: Group, op: EOp, +seq: Nat) -> Group:
  match g op:
    case Group{key, s, inserted, last, cols} Inserted{}:
      Group{key, seq, True{}, Inserted{}, cols}
    case Group{key, s, inserted, last, cols} Updated{+col}:
      Group{key, seq, inserted, Updated{col}, cols.add(cols, col)}
    case Group{key, s, inserted, last, cols} Deleted{}:
      Group{key, seq, inserted, Deleted{}, cols}

def groups.add(gs: List<&2, Group>, +key: Key, +op: EOp, +seq: Nat) -> List<&2, Group>:
  match gs:
    case Nil{}:
      [Group.note(Group{key, seq, False{}, op, Nil{}}, op, seq)]
    case Con{+g, +rest}:
      KMap.if(List<&2, Group>, Group.note(g, op, seq) <> rest, g <> groups.add(rest, key, op, seq), Key.eq(Group.key(g), key))

def collect.groups(outbox: List<&2, Entry>, gs: List<&2, Group>) -> List<&2, Group>:
  match outbox:
    case Nil{}:
      gs
    case Con{Entry{seq, table, id, op}, rest}:
      collect.groups(rest, groups.add(gs, RowKey{table, id}, op, seq))

def project.put(hit: Maybe<&2, Nat>, +c: Nat, tail: NMap<Nat>) -> NMap<Nat>:
  match hit:
    case None{}:
      tail
    case Some{v}:
      NCon{c, v, tail}

# the recorded columns with their current values; a column the sparse row lacks is left out
def project(cols: List<&2, Nat>, +row: NMap<Nat>) -> NMap<Nat>:
  match cols:
    case Nil{}:
      NNil{}
    case Con{+c, rest}:
      project.put(NMap.lookup(Nat, row, c), c, project(rest, row))

# last op delete: a delete; else a missing row drops the group; inserted: a put; else a patch of the recorded columns
def collect.write(+client: Nat, table: Nat, id: Nat, seq: Nat, last: EOp, hit: Maybe<&2, NMap<Nat>>, inserted: Bool, cols: List<&2, Nat>) -> Maybe<&2, Write>:
  match last:
    case Deleted{}:
      Some{Write{client, seq, Delete{}, table, id}}
    case other:
      match hit:
        case None{}:
          None{}
        case Some{row}:
          match inserted:
            case True{}:
              Some{Write{client, seq, Put{row}, table, id}}
            case False{}:
              Some{Write{client, seq, Patch{project(cols, row)}, table, id}}

def collect.cons(w: Maybe<&2, Write>, tail: List<&2, Write>) -> List<&2, Write>:
  match w:
    case None{}:
      tail
    case Some{x}:
      x <> tail

def collect.writes(+client: Nat, +local: KMap<NMap<Nat>>, gs: List<&2, Group>) -> List<&2, Write>:
  match gs:
    case Nil{}:
      Nil{}
    case Con{Group{RowKey{+table, +id}, seq, inserted, last, cols}, rest}:
      collect.cons(collect.write(client, table, id, seq, last, KMap.lookup(NMap<Nat>, local, RowKey{table, id}), inserted, cols), collect.writes(client, local, rest))

def collect(+client: Nat, +local: KMap<NMap<Nat>>, outbox: List<&2, Entry>) -> List<&2, Write>:
  collect.writes(client, local, collect.groups(outbox, Nil{}))
