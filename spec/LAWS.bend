import Base
import ./sync.bend as S

law replay_idempotent:
  for +s: S.State
  for +w: S.Write
  {S.apply(S.apply(s, w), w) == S.apply(s, w) : S.State}

law head_monotonic:
  for +s: S.State
  for +w: S.Write
  {Nat.is_ge(S.State.head(S.apply(s, w)), S.State.head(s)) == True{} : Bool}

# Convergence, pointwise: a client that agrees with the server on every key it is
# not behind on (stamp <= cursor) agrees on every key after one pull.
law converge:
  for +s: S.State
  for +c: S.Client
  for +k: S.Key
  for inv: {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(s), k, 0n), S.Client.cursor(c)) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, S.Client.local(c), k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(s), k) : Maybe<&2, S.NMap<Nat>>}
  {S.KMap.lookup(S.NMap<Nat>, S.Client.local(S.applyPull(c, S.pull(s, S.Client.cursor(c)))), k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(s), k) : Maybe<&2, S.NMap<Nat>>}

# The convergence premise survives a server write: if the client was not ahead
# of the server, it still agrees on every key it is not behind on afterwards.
law inv_preserved:
  for +s: S.State
  for +w: S.Write
  for +local: S.KMap<S.NMap<Nat>>
  for +cursor: Nat
  for +k: S.Key
  for +le: {True{} == Nat.is_le(cursor, S.State.head(s)) : Bool}
  for inv: {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(s), k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(s), k) : Maybe<&2, S.NMap<Nat>>}
  for h: {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(S.apply(s, w)), k, 0n), cursor) : Bool}
  {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(S.apply(s, w)), k) : Maybe<&2, S.NMap<Nat>>}

law compact_rows:
  for +s: S.State
  for +h: Nat
  {S.State.rows(S.compact(s, h)) == S.State.rows(s) : S.KMap<S.NMap<Nat>>}

law compact_head:
  for +s: S.State
  for +h: Nat
  {S.State.head(S.compact(s, h)) == S.State.head(s) : Nat}

# Convergence for every cursor once tombstones can be dropped: a cursor below
# the horizon gets a snapshot and needs no premise; a cursor at or above it
# gets a delta and the premise of `converge` applies.
law converge_compacted:
  for +s: S.State
  for +c: S.Client
  for +k: S.Key
  for inv: {True{} == Nat.is_le(S.State.horizon(s), S.Client.cursor(c)) : Bool} -> {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(s), k, 0n), S.Client.cursor(c)) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, S.Client.local(c), k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(s), k) : Maybe<&2, S.NMap<Nat>>}
  {S.KMap.lookup(S.NMap<Nat>, S.Client.local(S.applyPull(c, S.pull(s, S.Client.cursor(c)))), k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(s), k) : Maybe<&2, S.NMap<Nat>>}

# Batch order: swapping two neighbours with different seqs in the arrival
# order changes nothing. Adjacent swaps reach every arrival order, so a batch
# lands the same however the outbox interleaved it.
law batch_order:
  for +s: S.State
  for +xs: List<&2, S.Write>
  for +a: S.Write
  for +b: S.Write
  for +ys: List<&2, S.Write>
  for +ne: {False{} == Nat.is_eq(S.Write.seq(a), S.Write.seq(b)) : Bool}
  {S.applyBatch(s, List.append(&2, S.Write, xs, a <> (b <> ys))) == S.applyBatch(s, List.append(&2, S.Write, xs, b <> (a <> ys))) : S.State}

# Batch completeness: a batch of distinct seqs all above clients[c], in
# ascending order, applies every write (the replay guard never fires) and
# leaves clients[c] at the last seq. With batch_order this holds for any
# arrival order.
law batch_complete:
  for +s: S.State
  for +c: Nat
  for +ws: List<&2, S.Write>
  for +asc: {True{} == S.Asc(ws, S.NMap.get(Nat, S.State.clients(s), c, 0n), c) : Bool}
  {S.applyBatch(s, ws) == S.applyForce(ws, s) : S.State}

law batch_acked:
  for +s: S.State
  for +c: Nat
  for +ws: List<&2, S.Write>
  for +asc: {True{} == S.Asc(ws, S.NMap.get(Nat, S.State.clients(s), c, 0n), c) : Bool}
  {S.NMap.get(Nat, S.State.clients(S.applyBatch(s, ws)), c, 0n) == S.lastSeq(ws, S.NMap.get(Nat, S.State.clients(s), c, 0n)) : Nat}
