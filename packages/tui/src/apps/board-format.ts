/** Dollar cost for live-board rows: cents precision from $0.095 up, tenths of a cent below. */
export function formatBoardCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}
