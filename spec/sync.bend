import Base

type Key is Data:
  RowKey{table: Nat, id: Nat}

def Key.eq(+a: Key, +b: Key) -> Bool:
  match a b:
    case RowKey{at, ai} RowKey{bt, bi}:
      Bool.and(Nat.is_eq(at, bt), Nat.is_eq(ai, bi))

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
  State{rows: KMap<NMap<Nat>>, head: Nat, changes: KMap<Nat>, clients: NMap<Nat>}

def State.head(s: State) -> Nat:
  match s:
    case State{rows, head, changes, clients}:
      head

def State.rows(s: State) -> KMap<NMap<Nat>>:
  match s:
    case State{rows, head, changes, clients}:
      rows

def State.changes(s: State) -> KMap<Nat>:
  match s:
    case State{rows, head, changes, clients}:
      changes

# an applied write bumps head and stamps the key
def touch(rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, +key: Key) -> State:
  State{rows, 1n+head, KMap.set(Nat, changes, key, 1n+head), clients}

def apply.patch(cur: Maybe<&2, NMap<Nat>>, cols: NMap<Nat>, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>) -> State:
  match cur:
    case None{}:
      State{rows, head, changes, clients}
    case Some{row}:
      touch(KMap.set(NMap<Nat>, rows, key, NMap.merge(Nat, cols, row)), head, changes, clients, key)

def apply.row(op: Op, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>) -> State:
  match op:
    case Put{row}:
      touch(KMap.set(NMap<Nat>, rows, key, row), head, changes, clients, key)
    case Patch{cols}:
      apply.patch(KMap.lookup(NMap<Nat>, rows, key), cols, key, rows, head, changes, clients)
    case Delete{}:
      touch(KMap.del(NMap<Nat>, rows, key), head, changes, clients, key)

def apply.go(skip: Bool, op: Op, +key: Key, +rows: KMap<NMap<Nat>>, +head: Nat, changes: KMap<Nat>, clients: NMap<Nat>, +client: Nat, +seq: Nat) -> State:
  match skip:
    case True{}:
      State{rows, head, changes, clients}
    case False{}:
      apply.row(op, key, rows, head, changes, NMap.set(Nat, clients, client, seq))

def apply(s: State, w: Write) -> State:
  match s w:
    case State{+rows, +head, changes, +clients} Write{+client, +seq, op, table, id}:
      apply.go(Nat.is_le(seq, NMap.get(Nat, clients, client, 0n)), op, RowKey{table, id}, rows, head, changes, clients, client, seq)

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

def pull(s: State, +cursor: Nat) -> List<&2, Pulled> & Nat:
  match s:
    case State{rows, head, changes, clients}:
      (pull.go(changes, rows, cursor), head)

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

def applyPull(c: Client, pulled: List<&2, Pulled> & Nat) -> Client:
  match c:
    case Client{local, cursor}:
      (items, head) = pulled
      Client{applyPull.go(items, local), head}
