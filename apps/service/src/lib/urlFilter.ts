import { type Condition, type FilterNode, isCondition } from "@jsudc/core";
import { decodeFilterParam, encodeFilterParam, PARAM } from "@jsudc/react/headless";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

const sameAs = (condition: Condition) => (node: FilterNode) =>
  isCondition(node) && node.field === condition.field && node.op === condition.op;

/**
 * `search` with `condition` in the data view's `?f=` (first, replacing one on the same field and
 * op; every other condition kept) and its page reset — so `<UdcDataView>` opens narrowed, with
 * the condition visible as a chip.
 */
export function withCondition(search: string, condition: Condition): string {
  const params = new URLSearchParams(search);
  const tree = decodeFilterParam(params.get(PARAM.filter));
  const same = sameAs(condition);
  let next: FilterNode;
  if (!tree || same(tree)) next = condition;
  else if (!isCondition(tree) && "and" in tree) {
    next = { and: [condition, ...tree.and.filter((n) => !same(n))] };
  } else next = { and: [condition, tree] };
  params.set(PARAM.filter, encodeFilterParam(next) ?? "");
  params.delete(PARAM.page);
  return `?${params.toString()}`;
}

/**
 * Puts `condition` into `?f=` on the first render (replacing the history entry) and answers
 * `true` once the URL carries it: mount the data view then, so its first list is narrowed.
 */
export function useUrlCondition(condition: Condition): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const [first] = useState(() => {
    const search = withCondition(location.search, condition);
    return search === location.search ? null : search;
  });
  const arrived = useRef(first === null);
  if (!arrived.current && location.search === first) arrived.current = true;
  const asked = useRef(false);
  useEffect(() => {
    if (first === null || asked.current) return;
    asked.current = true;
    navigate({ search: first }, { replace: true });
  }, [first, navigate]);
  return arrived.current;
}
