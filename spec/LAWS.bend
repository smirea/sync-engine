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
