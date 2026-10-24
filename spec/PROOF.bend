import Base
import ./sync.bend as S
import ./LAWS.bend as Laws

def Nat.eq_refl(n: Nat) -> {True{} == Nat.is_eq(n, n) : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      Nat.eq_refl(p)

def Nat.le_refl(n: Nat) -> {True{} == Nat.is_le(n, n) : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      Nat.le_refl(p)

def Nat.ge_succ(n: Nat) -> {True{} == Nat.is_ge(1n+n, n) : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      Nat.ge_succ(p)

def NMap.get_set.if(+key: Nat, +val: Nat, +rest: S.NMap<Nat>, +k: Nat, +v: Nat, +d: Nat, b: Bool, +e: {b == Nat.is_eq(key, k) : Bool}, ih: {v == S.NMap.get(Nat, S.NMap.set(Nat, rest, k, v), k, d) : Nat}) -> {v == S.NMap.get(Nat, S.NMap.set(Nat, S.NCon{key, val, rest}, k, v), k, d) : Nat}:
  match b:
    case True{}:
      %e : {v == S.NMap.get(Nat, S.NMap.if(S.NMap<Nat>, S.NCon{key, v, rest}, S.NCon{key, val, S.NMap.set(Nat, rest, k, v)}, _), k, d) : Nat}
      %e : {v == S.NMap.if(Nat, v, S.NMap.get(Nat, rest, k, d), _) : Nat}
      {==}
    case False{}:
      %e : {v == S.NMap.get(Nat, S.NMap.if(S.NMap<Nat>, S.NCon{key, v, rest}, S.NCon{key, val, S.NMap.set(Nat, rest, k, v)}, _), k, d) : Nat}
      %e : {v == S.NMap.if(Nat, val, S.NMap.get(Nat, S.NMap.set(Nat, rest, k, v), k, d), _) : Nat}
      ih

def NMap.get_set(m: S.NMap<Nat>, +k: Nat, +v: Nat, +d: Nat) -> {v == S.NMap.get(Nat, S.NMap.set(Nat, m, k, v), k, d) : Nat}:
  match m:
    case S.NNil{}:
      %Nat.eq_refl(k) : {v == S.NMap.if(Nat, v, d, _) : Nat}
      {==}
    case S.NCon{+key, +val, +rest}:
      NMap.get_set.if(key, val, rest, k, v, d, Nat.is_eq(key, k), {==}, NMap.get_set(rest, k, v, d))

def skip_after_set(clients: S.NMap<Nat>, +client: Nat, +seq: Nat) -> {True{} == Nat.is_le(seq, S.NMap.get(Nat, S.NMap.set(Nat, clients, client, seq), client, 0n)) : Bool}:
  %NMap.get_set(clients, client, seq, 0n) : {True{} == Nat.is_le(seq, _) : Bool}
  Nat.le_refl(seq)

# a state whose client entry already holds seq skips the same write
def apply_skips(+rows: S.KMap<S.NMap<Nat>>, +head: Nat, +changes: S.KMap<Nat>, +clients: S.NMap<Nat>, +client: Nat, +seq: Nat, op: S.Op, +table: Nat, +id: Nat) -> {S.apply(S.State{rows, head, changes, S.NMap.set(Nat, clients, client, seq)}, S.Write{client, seq, op, table, id}) == S.State{rows, head, changes, S.NMap.set(Nat, clients, client, seq)} : S.State}:
  %skip_after_set(clients, client, seq) : {S.apply.go(_, op, S.RowKey{table, id}, rows, head, changes, S.NMap.set(Nat, clients, client, seq), client, seq) == S.State{rows, head, changes, S.NMap.set(Nat, clients, client, seq)} : S.State}
  {==}

def idem.patch(cur: Maybe<&2, S.NMap<Nat>>, +cols: S.NMap<Nat>, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, +changes: S.KMap<Nat>, +clients: S.NMap<Nat>, +client: Nat, +seq: Nat, +table: Nat, +id: Nat) -> {S.apply(S.apply.patch(cur, cols, S.RowKey{table, id}, rows, head, changes, S.NMap.set(Nat, clients, client, seq)), S.Write{client, seq, S.Patch{cols}, table, id}) == S.apply.patch(cur, cols, S.RowKey{table, id}, rows, head, changes, S.NMap.set(Nat, clients, client, seq)) : S.State}:
  match cur:
    case None{}:
      apply_skips(rows, head, changes, clients, client, seq, S.Patch{cols}, table, id)
    case Some{+row}:
      apply_skips(S.KMap.set(S.NMap<Nat>, rows, S.RowKey{table, id}, S.NMap.merge(Nat, cols, row)), 1n+head, S.KMap.set(Nat, changes, S.RowKey{table, id}, 1n+head), clients, client, seq, S.Patch{cols}, table, id)

def idem.go(b: Bool, +op: S.Op, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, +changes: S.KMap<Nat>, +clients: S.NMap<Nat>, +client: Nat, +seq: Nat, +table: Nat, +id: Nat, +e: {b == Nat.is_le(seq, S.NMap.get(Nat, clients, client, 0n)) : Bool}) -> {S.apply(S.apply.go(b, op, S.RowKey{table, id}, rows, head, changes, clients, client, seq), S.Write{client, seq, op, table, id}) == S.apply.go(b, op, S.RowKey{table, id}, rows, head, changes, clients, client, seq) : S.State}:
  match b:
    case True{}:
      %e : {S.apply.go(_, op, S.RowKey{table, id}, rows, head, changes, clients, client, seq) == S.State{rows, head, changes, clients} : S.State}
      {==}
    case False{}:
      match op:
        case S.Put{+row}:
          apply_skips(S.KMap.set(S.NMap<Nat>, rows, S.RowKey{table, id}, row), 1n+head, S.KMap.set(Nat, changes, S.RowKey{table, id}, 1n+head), clients, client, seq, S.Put{row}, table, id)
        case S.Patch{+cols}:
          idem.patch(S.KMap.lookup(S.NMap<Nat>, rows, S.RowKey{table, id}), cols, rows, head, changes, clients, client, seq, table, id)
        case S.Delete{}:
          apply_skips(S.KMap.del(S.NMap<Nat>, rows, S.RowKey{table, id}), 1n+head, S.KMap.set(Nat, changes, S.RowKey{table, id}, 1n+head), clients, client, seq, S.Delete{}, table, id)

def Laws.replay_idempotent(s, w):
  match s w:
    case S.State{+rows, +head, +changes, +clients} S.Write{+client, +seq, +op, +table, +id}:
      idem.go(Nat.is_le(seq, S.NMap.get(Nat, clients, client, 0n)), op, rows, head, changes, clients, client, seq, table, id, {==})

def mono.patch(cur: Maybe<&2, S.NMap<Nat>>, cols: S.NMap<Nat>, +key: S.Key, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, changes: S.KMap<Nat>, clients: S.NMap<Nat>) -> {True{} == Nat.is_ge(S.State.head(S.apply.patch(cur, cols, key, rows, head, changes, clients)), head) : Bool}:
  match cur:
    case None{}:
      Equal.sym(Bool, Nat.is_ge(head, head), True{}, Nat.ge_refl(head))
    case Some{row}:
      Nat.ge_succ(head)

def mono.go(b: Bool, op: S.Op, +key: S.Key, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, changes: S.KMap<Nat>, clients: S.NMap<Nat>, +client: Nat, +seq: Nat) -> {True{} == Nat.is_ge(S.State.head(S.apply.go(b, op, key, rows, head, changes, clients, client, seq)), head) : Bool}:
  match b:
    case True{}:
      Equal.sym(Bool, Nat.is_ge(head, head), True{}, Nat.ge_refl(head))
    case False{}:
      match op:
        case S.Put{row}:
          Nat.ge_succ(head)
        case S.Patch{cols}:
          mono.patch(S.KMap.lookup(S.NMap<Nat>, rows, key), cols, key, rows, head, changes, S.NMap.set(Nat, clients, client, seq))
        case S.Delete{}:
          Nat.ge_succ(head)

def Laws.head_monotonic(s, w):
  match s w:
    case S.State{+rows, +head, changes, clients} S.Write{+client, +seq, op, table, id}:
      Equal.sym(Bool, True{}, Nat.is_ge(S.State.head(S.apply(s, w)), head), mono.go(Nat.is_le(seq, S.NMap.get(Nat, clients, client, 0n)), op, S.RowKey{table, id}, rows, head, changes, clients, client, seq))


def Bool.disc_tf(b: Bool, A: Type) -> Type:
  match b:
    case True{}:
      Unit
    case False{}:
      A

def Bool.absurd_tf(-A: Type, e: {True{} == False{} : Bool}) -> A:
  %e : Bool.disc_tf(_, A)
  Unit{}

def Bool.disc_ft(b: Bool, A: Type) -> Type:
  match b:
    case False{}:
      Unit
    case True{}:
      A

def Bool.absurd_ft(-A: Type, e: {False{} == True{} : Bool}) -> A:
  %e : Bool.disc_ft(_, A)
  Unit{}

def Bool.and_l(x: Bool, +y: Bool, e: {True{} == Bool.and(x, y) : Bool}) -> {True{} == x : Bool}:
  match x:
    case True{}:
      {==}
    case False{}:
      Bool.absurd_tf({True{} == False{} : Bool}, e)

def Bool.and_r(x: Bool, +y: Bool, e: {True{} == Bool.and(x, y) : Bool}) -> {True{} == y : Bool}:
  match x:
    case True{}:
      e
    case False{}:
      Bool.absurd_tf({True{} == y : Bool}, e)

def Nat.eq_to_equal(a: Nat, b: Nat, e: {True{} == Nat.is_eq(a, b) : Bool}) -> {b == a : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      Bool.absurd_tf({1n+q == 0n : Nat}, e)
    case 1n+p 0n:
      Bool.absurd_tf({0n == 1n+p : Nat}, e)
    case 1n+p 1n+q:
      %Nat.eq_to_equal(p, q, e) : {1n+q == 1n+_ : Nat}
      {==}

def Key.eq_refl(k: S.Key) -> {True{} == S.Key.eq(k, k) : Bool}:
  match k:
    case S.RowKey{+t, +i}:
      %Nat.eq_refl(t) : {True{} == Bool.and(_, Nat.is_eq(i, i)) : Bool}
      %Nat.eq_refl(i) : {True{} == Bool.and(True{}, _) : Bool}
      {==}

def Key.eq_to_equal(a: S.Key, b: S.Key, +e: {True{} == S.Key.eq(a, b) : Bool}) -> {b == a : S.Key}:
  match a b:
    case S.RowKey{+at, +ai} S.RowKey{+bt, +bi}:
      %Nat.eq_to_equal(at, bt, Bool.and_l(Nat.is_eq(at, bt), Nat.is_eq(ai, bi), e)) : {S.RowKey{bt, bi} == S.RowKey{_, ai} : S.Key}
      %Nat.eq_to_equal(ai, bi, Bool.and_r(Nat.is_eq(at, bt), Nat.is_eq(ai, bi), e)) : {S.RowKey{bt, bi} == S.RowKey{bt, _} : S.Key}
      {==}

def Nat.le_zero(c: Nat) -> {True{} == Nat.is_le(0n, c) : Bool}:
  match c:
    case 0n:
      {==}
    case 1n+p:
      {==}

def Cmp.not_gt_le(c: Cmp, e: {False{} == Cmp.is_gt(c) : Bool}) -> {True{} == Cmp.is_le(c) : Bool}:
  match c:
    case LT{}:
      {==}
    case EQ{}:
      {==}
    case GT{}:
      Bool.absurd_ft({True{} == False{} : Bool}, e)

def KMap.lookup_set_same.if(+key: S.Key, +val: S.NMap<Nat>, +rest: S.KMap<S.NMap<Nat>>, +k: S.Key, +v: S.NMap<Nat>, b: Bool, +e: {b == S.Key.eq(key, k) : Bool}, ih: {S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, rest, k, v), k) == Some{v} : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, S.KCon{key, val, rest}, k, v), k) == Some{v} : Maybe<&2, S.NMap<Nat>>}:
  match b:
    case True{}:
      %e : {S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KCon{key, v, rest}, S.KCon{key, val, S.KMap.set(S.NMap<Nat>, rest, k, v)}, _), k) == Some{v} : Maybe<&2, S.NMap<Nat>>}
      %e : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{v}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == Some{v} : Maybe<&2, S.NMap<Nat>>}
      {==}
    case False{}:
      %e : {S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KCon{key, v, rest}, S.KCon{key, val, S.KMap.set(S.NMap<Nat>, rest, k, v)}, _), k) == Some{v} : Maybe<&2, S.NMap<Nat>>}
      %e : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, rest, k, v), k), _) == Some{v} : Maybe<&2, S.NMap<Nat>>}
      ih

def KMap.lookup_set_same(m: S.KMap<S.NMap<Nat>>, +k: S.Key, +v: S.NMap<Nat>) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, m, k, v), k) == Some{v} : Maybe<&2, S.NMap<Nat>>}:
  match m:
    case S.KNil{}:
      %Key.eq_refl(k) : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{v}, None{}, _) == Some{v} : Maybe<&2, S.NMap<Nat>>}
      {==}
    case S.KCon{+key, +val, +rest}:
      KMap.lookup_set_same.if(key, val, rest, k, v, S.Key.eq(key, k), {==}, KMap.lookup_set_same(rest, k, v))

def KMap.lookup_del_same.if(+key: S.Key, +val: S.NMap<Nat>, +rest: S.KMap<S.NMap<Nat>>, +k: S.Key, b: Bool, +e: {b == S.Key.eq(key, k) : Bool}, ih: {S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, k), k) == None{} : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, S.KCon{key, val, rest}, k), k) == None{} : Maybe<&2, S.NMap<Nat>>}:
  match b:
    case True{}:
      %e : {S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KMap.del(S.NMap<Nat>, rest, k), S.KCon{key, val, S.KMap.del(S.NMap<Nat>, rest, k)}, _), k) == None{} : Maybe<&2, S.NMap<Nat>>}
      ih
    case False{}:
      %e : {S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KMap.del(S.NMap<Nat>, rest, k), S.KCon{key, val, S.KMap.del(S.NMap<Nat>, rest, k)}, _), k) == None{} : Maybe<&2, S.NMap<Nat>>}
      %e : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, k), k), _) == None{} : Maybe<&2, S.NMap<Nat>>}
      ih

def KMap.lookup_del_same(m: S.KMap<S.NMap<Nat>>, +k: S.Key) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, m, k), k) == None{} : Maybe<&2, S.NMap<Nat>>}:
  match m:
    case S.KNil{}:
      {==}
    case S.KCon{+key, +val, +rest}:
      KMap.lookup_del_same.if(key, val, rest, k, S.Key.eq(key, k), {==}, KMap.lookup_del_same(rest, k))

def KMap.lookup_set_miss.if(+key2: S.Key, +val: S.NMap<Nat>, +rest: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, +v: S.NMap<Nat>, b2: Bool, +e2: {b2 == S.Key.eq(key2, key) : Bool}, b3: Bool, +e3: {b3 == S.Key.eq(key2, k) : Bool}, +e: {False{} == S.Key.eq(key, k) : Bool}, ih: {S.KMap.lookup(S.NMap<Nat>, rest, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, rest, key, v), k) : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.KCon{key2, val, rest}, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, S.KCon{key2, val, rest}, key, v), k) : Maybe<&2, S.NMap<Nat>>}:
  match b2 b3:
    case True{} _:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(S.NMap<Nat>, rest, key, v)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %Key.eq_to_equal(key2, key, e2) : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(_, k)) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{v}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(_, k)) : Maybe<&2, S.NMap<Nat>>}
      %e : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{v}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) : Maybe<&2, S.NMap<Nat>>}
      {==}
    case False{} True{}:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(S.NMap<Nat>, rest, key, v)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %e3 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, rest, key, v), k), _) : Maybe<&2, S.NMap<Nat>>}
      {==}
    case False{} False{}:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(S.NMap<Nat>, rest, key, v)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %e3 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, rest, key, v), k), _) : Maybe<&2, S.NMap<Nat>>}
      ih

def KMap.lookup_set_miss(m: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, +v: S.NMap<Nat>, +e: {False{} == S.Key.eq(key, k) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, m, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.set(S.NMap<Nat>, m, key, v), k) : Maybe<&2, S.NMap<Nat>>}:
  match m:
    case S.KNil{}:
      %e : {None{} == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{v}, None{}, _) : Maybe<&2, S.NMap<Nat>>}
      {==}
    case S.KCon{+key2, +val, +rest}:
      KMap.lookup_set_miss.if(key2, val, rest, key, k, v, S.Key.eq(key2, key), {==}, S.Key.eq(key2, k), {==}, e, KMap.lookup_set_miss(rest, key, k, v, e))

def KMap.lookup_del_miss.if(+key2: S.Key, +val: S.NMap<Nat>, +rest: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, b2: Bool, +e2: {b2 == S.Key.eq(key2, key) : Bool}, b3: Bool, +e3: {b3 == S.Key.eq(key2, k) : Bool}, +e: {False{} == S.Key.eq(key, k) : Bool}, ih: {S.KMap.lookup(S.NMap<Nat>, rest, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, key), k) : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.KCon{key2, val, rest}, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, S.KCon{key2, val, rest}, key), k) : Maybe<&2, S.NMap<Nat>>}:
  match b2 b3:
    case True{} _:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KMap.del(S.NMap<Nat>, rest, key), S.KCon{key2, val, S.KMap.del(S.NMap<Nat>, rest, key)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %Key.eq_to_equal(key2, key, e2) : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(_, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, key), k) : Maybe<&2, S.NMap<Nat>>}
      %e : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, key), k) : Maybe<&2, S.NMap<Nat>>}
      ih
    case False{} True{}:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KMap.del(S.NMap<Nat>, rest, key), S.KCon{key2, val, S.KMap.del(S.NMap<Nat>, rest, key)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %e3 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, key), k), _) : Maybe<&2, S.NMap<Nat>>}
      {==}
    case False{} False{}:
      %e2 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), S.Key.eq(key2, k)) == S.KMap.lookup(S.NMap<Nat>, S.KMap.if(S.KMap<S.NMap<Nat>>, S.KMap.del(S.NMap<Nat>, rest, key), S.KCon{key2, val, S.KMap.del(S.NMap<Nat>, rest, key)}, _), k) : Maybe<&2, S.NMap<Nat>>}
      %e3 : {S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, rest, k), _) == S.KMap.if(Maybe<&2, S.NMap<Nat>>, Some{val}, S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, rest, key), k), _) : Maybe<&2, S.NMap<Nat>>}
      ih

def KMap.lookup_del_miss(m: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, +e: {False{} == S.Key.eq(key, k) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, m, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.del(S.NMap<Nat>, m, key), k) : Maybe<&2, S.NMap<Nat>>}:
  match m:
    case S.KNil{}:
      {==}
    case S.KCon{+key2, +val, +rest}:
      KMap.lookup_del_miss.if(key2, val, rest, key, k, S.Key.eq(key2, key), {==}, S.Key.eq(key2, k), {==}, e, KMap.lookup_del_miss(rest, key, k, e))

def KMap.put_hit(m: S.KMap<S.NMap<Nat>>, +k: S.Key, mv: Maybe<&2, S.NMap<Nat>>) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.put(S.NMap<Nat>, m, k, mv), k) == mv : Maybe<&2, S.NMap<Nat>>}:
  match mv:
    case None{}:
      KMap.lookup_del_same(m, k)
    case Some{+v}:
      KMap.lookup_set_same(m, k, v)

def KMap.put_miss(m: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, mv: Maybe<&2, S.NMap<Nat>>, +e: {False{} == S.Key.eq(key, k) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, m, k) == S.KMap.lookup(S.NMap<Nat>, S.KMap.put(S.NMap<Nat>, m, key, mv), k) : Maybe<&2, S.NMap<Nat>>}:
  match mv:
    case None{}:
      KMap.lookup_del_miss(m, key, k, e)
    case Some{+v}:
      KMap.lookup_set_miss(m, key, k, v, e)

# the client is not behind on k once the head entry is for another key
def conv.hyp(+key: S.Key, +stamp: Nat, +rest: S.KMap<Nat>, +k: S.Key, +cursor: Nat, +eb: {False{} == S.Key.eq(key, k) : Bool}, h: {True{} == Nat.is_le(S.KMap.get(Nat, rest, k, 0n), cursor) : Bool}) -> {True{} == Nat.is_le(S.KMap.get(Nat, S.KCon{key, stamp, rest}, k, 0n), cursor) : Bool}:
  %eb : {True{} == Nat.is_le(S.KMap.if(Nat, stamp, S.KMap.get(Nat, rest, k, 0n), _), cursor) : Bool}
  h

# nor once the head entry is for k itself but stale
def conv.hyp_same(+key: S.Key, +stamp: Nat, +rest: S.KMap<Nat>, +k: S.Key, +cursor: Nat, +eb: {True{} == S.Key.eq(key, k) : Bool}, eg: {False{} == Nat.is_gt(stamp, cursor) : Bool}) -> {True{} == Nat.is_le(S.KMap.get(Nat, S.KCon{key, stamp, rest}, k, 0n), cursor) : Bool}:
  %eb : {True{} == Nat.is_le(S.KMap.if(Nat, stamp, S.KMap.get(Nat, rest, k, 0n), _), cursor) : Bool}
  Cmp.not_gt_le(Nat.cmp(stamp, cursor), eg)

def conv.same(+local: S.KMap<S.NMap<Nat>>, +rows: S.KMap<S.NMap<Nat>>, +key: S.Key, +k: S.Key, +eb: {True{} == S.Key.eq(key, k) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.put(S.NMap<Nat>, local, key, S.KMap.lookup(S.NMap<Nat>, rows, key)), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}:
  %Key.eq_to_equal(key, k, eb) : {S.KMap.lookup(S.NMap<Nat>, S.KMap.put(S.NMap<Nat>, local, _, S.KMap.lookup(S.NMap<Nat>, rows, _)), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
  KMap.put_hit(local, k, S.KMap.lookup(S.NMap<Nat>, rows, k))

def conv.other(+rest: S.KMap<Nat>, +rows: S.KMap<S.NMap<Nat>>, +local: S.KMap<S.NMap<Nat>>, +cursor: Nat, +k: S.Key, +key: S.Key, +stamp: Nat, +eb: {False{} == S.Key.eq(key, k) : Bool}, inv: {True{} == Nat.is_le(S.KMap.get(Nat, S.KCon{key, stamp, rest}, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}, h: {True{} == Nat.is_le(S.KMap.get(Nat, rest, k, 0n), cursor) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, S.KMap.put(S.NMap<Nat>, local, key, S.KMap.lookup(S.NMap<Nat>, rows, key)), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}:
  %KMap.put_miss(local, key, k, S.KMap.lookup(S.NMap<Nat>, rows, key), eb) : {_ == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
  inv(conv.hyp(key, stamp, rest, k, cursor, eb, h))

def conv.step(+rest: S.KMap<Nat>, +rows: S.KMap<S.NMap<Nat>>, +local: S.KMap<S.NMap<Nat>>, +cursor: Nat, +k: S.Key, +key: S.Key, +stamp: Nat, g: Bool, +eg: {g == Nat.is_gt(stamp, cursor) : Bool}, b: Bool, +eb: {b == S.Key.eq(key, k) : Bool}, inv: {True{} == Nat.is_le(S.KMap.get(Nat, S.KCon{key, stamp, rest}, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}, ih: @local2: S.KMap<S.NMap<Nat>> -> ({True{} == Nat.is_le(S.KMap.get(Nat, rest, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local2, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.pull.go(rest, rows, cursor), local2), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.pull.go(S.KCon{key, stamp, rest}, rows, cursor), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}:
  match g b:
    case True{} True{}:
      %eg : {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.KMap.if(List<&2, S.Pulled>, S.Pulled{key, S.KMap.lookup(S.NMap<Nat>, rows, key)} <> S.pull.go(rest, rows, cursor), S.pull.go(rest, rows, cursor), _), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
      ih(S.KMap.put(S.NMap<Nat>, local, key, S.KMap.lookup(S.NMap<Nat>, rows, key)), _ => conv.same(local, rows, key, k, eb))
    case True{} False{}:
      %eg : {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.KMap.if(List<&2, S.Pulled>, S.Pulled{key, S.KMap.lookup(S.NMap<Nat>, rows, key)} <> S.pull.go(rest, rows, cursor), S.pull.go(rest, rows, cursor), _), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
      ih(S.KMap.put(S.NMap<Nat>, local, key, S.KMap.lookup(S.NMap<Nat>, rows, key)), h => conv.other(rest, rows, local, cursor, k, key, stamp, eb, inv, h))
    case False{} True{}:
      %eg : {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.KMap.if(List<&2, S.Pulled>, S.Pulled{key, S.KMap.lookup(S.NMap<Nat>, rows, key)} <> S.pull.go(rest, rows, cursor), S.pull.go(rest, rows, cursor), _), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
      ih(local, _ => inv(conv.hyp_same(key, stamp, rest, k, cursor, eb, eg)))
    case False{} False{}:
      %eg : {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.KMap.if(List<&2, S.Pulled>, S.Pulled{key, S.KMap.lookup(S.NMap<Nat>, rows, key)} <> S.pull.go(rest, rows, cursor), S.pull.go(rest, rows, cursor), _), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}
      ih(local, h => inv(conv.hyp(key, stamp, rest, k, cursor, eb, h)))

def conv.go(changes: S.KMap<Nat>, +rows: S.KMap<S.NMap<Nat>>, +local: S.KMap<S.NMap<Nat>>, +cursor: Nat, +k: S.Key, inv: {True{} == Nat.is_le(S.KMap.get(Nat, changes, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}) -> {S.KMap.lookup(S.NMap<Nat>, S.applyPull.go(S.pull.go(changes, rows, cursor), local), k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}:
  match changes:
    case S.KNil{}:
      inv(Nat.le_zero(cursor))
    case S.KCon{+key, +stamp, +rest}:
      conv.step(rest, rows, local, cursor, k, key, stamp, Nat.is_gt(stamp, cursor), {==}, S.Key.eq(key, k), {==}, inv, local2 => inv2 => conv.go(rest, rows, local2, cursor, k, inv2))

def Laws.converge(s, c, k, inv):
  match s c:
    case S.State{+rows, head, +changes, clients} S.Client{+local, +cursor}:
      conv.go(changes, rows, local, cursor, k, inv)


def Nat.le_succ_absurd(-A: Type, c: Nat, h: Nat, le: {True{} == Nat.is_le(c, h) : Bool}, h2: {True{} == Nat.is_le(1n+h, c) : Bool}) -> A:
  match c h:
    case 0n _:
      Bool.absurd_tf(A, h2)
    case 1n+p 0n:
      Bool.absurd_tf(A, le)
    case 1n+p 1n+q:
      Nat.le_succ_absurd(A, p, q, le, h2)

def KMap.get_set_same.if(-V: Data, +key: S.Key, +val: V, +rest: S.KMap<V>, +k: S.Key, +v: V, +d: V, b: Bool, +e: {b == S.Key.eq(key, k) : Bool}, ih: {S.KMap.get(V, S.KMap.set(V, rest, k, v), k, d) == v : V}) -> {S.KMap.get(V, S.KMap.set(V, S.KCon{key, val, rest}, k, v), k, d) == v : V}:
  match b:
    case True{}:
      %e : {S.KMap.get(V, S.KMap.if(S.KMap<V>, S.KCon{key, v, rest}, S.KCon{key, val, S.KMap.set(V, rest, k, v)}, _), k, d) == v : V}
      %e : {S.KMap.if(V, v, S.KMap.get(V, rest, k, d), _) == v : V}
      {==}
    case False{}:
      %e : {S.KMap.get(V, S.KMap.if(S.KMap<V>, S.KCon{key, v, rest}, S.KCon{key, val, S.KMap.set(V, rest, k, v)}, _), k, d) == v : V}
      %e : {S.KMap.if(V, val, S.KMap.get(V, S.KMap.set(V, rest, k, v), k, d), _) == v : V}
      ih

def KMap.get_set_same(-V: Data, m: S.KMap<V>, +k: S.Key, +v: V, +d: V) -> {S.KMap.get(V, S.KMap.set(V, m, k, v), k, d) == v : V}:
  match m:
    case S.KNil{}:
      %Key.eq_refl(k) : {S.KMap.if(V, v, d, _) == v : V}
      {==}
    case S.KCon{+key, +val, +rest}:
      KMap.get_set_same.if(V, key, val, rest, k, v, d, S.Key.eq(key, k), {==}, KMap.get_set_same(V, rest, k, v, d))

def KMap.get_set_hit(-V: Data, m: S.KMap<V>, +K: S.Key, +k: S.Key, +v: V, +d: V, +e: {True{} == S.Key.eq(K, k) : Bool}) -> {S.KMap.get(V, S.KMap.set(V, m, K, v), k, d) == v : V}:
  %Key.eq_to_equal(K, k, e) : {S.KMap.get(V, S.KMap.set(V, m, _, v), k, d) == v : V}
  KMap.get_set_same(V, m, k, v, d)

def KMap.get_set_miss.if(-V: Data, +key2: S.Key, +val: V, +rest: S.KMap<V>, +K: S.Key, +k: S.Key, +v: V, +d: V, b2: Bool, +e2: {b2 == S.Key.eq(key2, K) : Bool}, b3: Bool, +e3: {b3 == S.Key.eq(key2, k) : Bool}, +e: {False{} == S.Key.eq(K, k) : Bool}, ih: {S.KMap.get(V, S.KMap.set(V, rest, K, v), k, d) == S.KMap.get(V, rest, k, d) : V}) -> {S.KMap.get(V, S.KMap.set(V, S.KCon{key2, val, rest}, K, v), k, d) == S.KMap.get(V, S.KCon{key2, val, rest}, k, d) : V}:
  match b2 b3:
    case True{} _:
      %e2 : {S.KMap.get(V, S.KMap.if(S.KMap<V>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(V, rest, K, v)}, _), k, d) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), S.Key.eq(key2, k)) : V}
      %Key.eq_to_equal(key2, K, e2) : {S.KMap.if(V, v, S.KMap.get(V, rest, k, d), S.Key.eq(_, k)) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), S.Key.eq(_, k)) : V}
      %e : {S.KMap.if(V, v, S.KMap.get(V, rest, k, d), _) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), _) : V}
      {==}
    case False{} True{}:
      %e2 : {S.KMap.get(V, S.KMap.if(S.KMap<V>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(V, rest, K, v)}, _), k, d) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), S.Key.eq(key2, k)) : V}
      %e3 : {S.KMap.if(V, val, S.KMap.get(V, S.KMap.set(V, rest, K, v), k, d), _) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), _) : V}
      {==}
    case False{} False{}:
      %e2 : {S.KMap.get(V, S.KMap.if(S.KMap<V>, S.KCon{key2, v, rest}, S.KCon{key2, val, S.KMap.set(V, rest, K, v)}, _), k, d) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), S.Key.eq(key2, k)) : V}
      %e3 : {S.KMap.if(V, val, S.KMap.get(V, S.KMap.set(V, rest, K, v), k, d), _) == S.KMap.if(V, val, S.KMap.get(V, rest, k, d), _) : V}
      ih

def KMap.get_set_miss(-V: Data, m: S.KMap<V>, +K: S.Key, +k: S.Key, +v: V, +d: V, +e: {False{} == S.Key.eq(K, k) : Bool}) -> {S.KMap.get(V, S.KMap.set(V, m, K, v), k, d) == S.KMap.get(V, m, k, d) : V}:
  match m:
    case S.KNil{}:
      %e : {S.KMap.if(V, v, d, _) == d : V}
      {==}
    case S.KCon{+key2, +val, +rest}:
      KMap.get_set_miss.if(V, key2, val, rest, K, k, v, d, S.Key.eq(key2, K), {==}, S.Key.eq(key2, k), {==}, e, KMap.get_set_miss(V, rest, K, k, v, d, e))

# one touched key K: at K the new stamp 1+head is past the cursor, so the premise is absurd; elsewhere nothing moved
def pres.core(+rows: S.KMap<S.NMap<Nat>>, +rows2: S.KMap<S.NMap<Nat>>, +changes: S.KMap<Nat>, +K: S.Key, +head: Nat, +cursor: Nat, +k: S.Key, +local: S.KMap<S.NMap<Nat>>, b: Bool, +eb: {b == S.Key.eq(K, k) : Bool}, +le: {True{} == Nat.is_le(cursor, head) : Bool}, miss: {False{} == S.Key.eq(K, k) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, rows, k) == S.KMap.lookup(S.NMap<Nat>, rows2, k) : Maybe<&2, S.NMap<Nat>>}, inv: {True{} == Nat.is_le(S.KMap.get(Nat, changes, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}, h: {True{} == Nat.is_le(S.KMap.get(Nat, S.KMap.set(Nat, changes, K, 1n+head), k, 0n), cursor) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows2, k) : Maybe<&2, S.NMap<Nat>>}:
  match b:
    case True{}:
      Nat.le_succ_absurd({S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows2, k) : Maybe<&2, S.NMap<Nat>>}, cursor, head, le, Equal.trans(Bool, True{}, Nat.is_le(S.KMap.get(Nat, S.KMap.set(Nat, changes, K, 1n+head), k, 0n), cursor), Nat.is_le(1n+head, cursor), h, Equal.cong(Nat, Bool, x => Nat.is_le(x, cursor), S.KMap.get(Nat, S.KMap.set(Nat, changes, K, 1n+head), k, 0n), 1n+head, KMap.get_set_hit(Nat, changes, K, k, 1n+head, 0n, eb))))
    case False{}:
      %miss(eb) : {S.KMap.lookup(S.NMap<Nat>, local, k) == _ : Maybe<&2, S.NMap<Nat>>}
      inv(Equal.trans(Bool, True{}, Nat.is_le(S.KMap.get(Nat, S.KMap.set(Nat, changes, K, 1n+head), k, 0n), cursor), Nat.is_le(S.KMap.get(Nat, changes, k, 0n), cursor), h, Equal.cong(Nat, Bool, x => Nat.is_le(x, cursor), S.KMap.get(Nat, S.KMap.set(Nat, changes, K, 1n+head), k, 0n), S.KMap.get(Nat, changes, k, 0n), KMap.get_set_miss(Nat, changes, K, k, 1n+head, 0n, eb))))

def pres.patch(cur: Maybe<&2, S.NMap<Nat>>, +cols: S.NMap<Nat>, +K: S.Key, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, +changes: S.KMap<Nat>, +clients: S.NMap<Nat>, +local: S.KMap<S.NMap<Nat>>, +cursor: Nat, +k: S.Key, +le: {True{} == Nat.is_le(cursor, head) : Bool}, inv: {True{} == Nat.is_le(S.KMap.get(Nat, changes, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}, h: {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(S.apply.patch(cur, cols, K, rows, head, changes, clients)), k, 0n), cursor) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(S.apply.patch(cur, cols, K, rows, head, changes, clients)), k) : Maybe<&2, S.NMap<Nat>>}:
  match cur:
    case None{}:
      inv(h)
    case Some{+row}:
      pres.core(rows, S.KMap.set(S.NMap<Nat>, rows, K, S.NMap.merge(Nat, cols, row)), changes, K, head, cursor, k, local, S.Key.eq(K, k), {==}, le, e => KMap.lookup_set_miss(rows, K, k, S.NMap.merge(Nat, cols, row), e), inv, h)

def pres.go(b: Bool, +op: S.Op, +K: S.Key, +rows: S.KMap<S.NMap<Nat>>, +head: Nat, +changes: S.KMap<Nat>, +clients: S.NMap<Nat>, +client: Nat, +seq: Nat, +local: S.KMap<S.NMap<Nat>>, +cursor: Nat, +k: S.Key, +le: {True{} == Nat.is_le(cursor, head) : Bool}, inv: {True{} == Nat.is_le(S.KMap.get(Nat, changes, k, 0n), cursor) : Bool} -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, rows, k) : Maybe<&2, S.NMap<Nat>>}, h: {True{} == Nat.is_le(S.KMap.get(Nat, S.State.changes(S.apply.go(b, op, K, rows, head, changes, clients, client, seq)), k, 0n), cursor) : Bool}) -> {S.KMap.lookup(S.NMap<Nat>, local, k) == S.KMap.lookup(S.NMap<Nat>, S.State.rows(S.apply.go(b, op, K, rows, head, changes, clients, client, seq)), k) : Maybe<&2, S.NMap<Nat>>}:
  match b:
    case True{}:
      inv(h)
    case False{}:
      match op:
        case S.Put{+row}:
          pres.core(rows, S.KMap.set(S.NMap<Nat>, rows, K, row), changes, K, head, cursor, k, local, S.Key.eq(K, k), {==}, le, e => KMap.lookup_set_miss(rows, K, k, row, e), inv, h)
        case S.Patch{+cols}:
          pres.patch(S.KMap.lookup(S.NMap<Nat>, rows, K), cols, K, rows, head, changes, S.NMap.set(Nat, clients, client, seq), local, cursor, k, le, inv, h)
        case S.Delete{}:
          pres.core(rows, S.KMap.del(S.NMap<Nat>, rows, K), changes, K, head, cursor, k, local, S.Key.eq(K, k), {==}, le, e => KMap.lookup_del_miss(rows, K, k, e), inv, h)

def Laws.inv_preserved(s, w, local, cursor, k, le, inv, h):
  match s w:
    case S.State{+rows, +head, +changes, +clients} S.Write{+client, +seq, +op, +table, +id}:
      pres.go(Nat.is_le(seq, S.NMap.get(Nat, clients, client, 0n)), op, S.RowKey{table, id}, rows, head, changes, clients, client, seq, local, cursor, k, le, inv, h)
