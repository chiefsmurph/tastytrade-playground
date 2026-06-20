// Shared runtime types used across the project

export interface AccountBalance {
  account_number: string;
  cash_balance: number;
  long_equity_value: number;
  short_equity_value: number;
  long_derivative_value: number;
  short_derivative_value: number;
  long_futures_value: number;
  short_futures_value: number;
  long_futures_derivative_value: number;
  short_futures_derivative_value: number;
  long_margineable_value: number;
  short_margineable_value: number;
  margin_equity: number;
  equity_buying_power: number;
  derivative_buying_power: number;
  day_trading_buying_power: number;
  futures_margin_requirement: number;
  available_trading_funds: number;
  maintenance_requirement: number;
  maintenance_call_value: number;
  reg_t_call_value: number;
  day_trading_call_value: number;
  day_equity_call_value: number;
  net_liquidating_value: number;
  cash_available_to_withdraw: number;
  day_trade_excess: number;
  pending_cash: number;
  pending_cash_effect: string | null;
  long_cryptocurrency_value: number;
  short_cryptocurrency_value: number;
  cryptocurrency_margin_requirement: number;
  unsettled_cryptocurrency_fiat_amount: number;
  unsettled_cryptocurrency_fiat_effect: string | null;
  closed_loop_available_balance: number;
  equity_offering_margin_requirement: number;
  long_bond_value: number;
  bond_margin_requirement: number;
  snapshot_date: string | Date;
  reg_t_margin_requirement: number;
  futures_overnight_margin_requirement: number;
  futures_intraday_margin_requirement: number;
  maintenance_excess: number;
  pending_margin_interest: number;
  effective_cryptocurrency_buying_power: number;
  updated_at: string | Date;
  apex_starting_day_margin_equity?: number | null;
  buying_power_adjustment?: any;
  buying_power_adjustment_effect?: any;
  time_of_day?: any;
}

export interface CurrentPosition {
  account_number: string;
  symbol: string;
  instrument_type: string; // e.g. 'Equity', 'Option', etc.
  underlying_symbol?: string | null;
  quantity: number;
  quantity_direction?: string | null; // 'Long' | 'Short'
  close_price?: number | null;
  average_open_price?: number | null;
  multiplier?: number | null;
  cost_effect?: string | null;
  is_suppressed?: boolean;
  is_frozen?: boolean;
  realized_day_gain?: number | null;
  realized_today?: number | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  mark?: number | null;
  mark_price?: number | null;
  restricted_quantity?: number | null;
  expires_at?: string | Date | null;
  fixing_price?: number | null;
  deliverable_type?: string | null;
  average_yearly_market_close_price?: number | null;
  average_daily_market_close_price?: number | null;
  realized_day_gain_effect?: string | null;
  realized_day_gain_date?: string | Date | null;
  realized_today_effect?: string | null;
  realized_today_date?: string | Date | null;
}

export type InstrumentType = 'Equity' | 'Option' | 'Future' | string;

// Option chain types
export interface TickSize {
  threshold?: string;
  value: string;
}

export interface Deliverable {
  id: number;
  amount: string;
  'deliverable-type': string;
  description: string;
  'instrument-type': string;
  percent: string;
  'root-symbol': string;
  symbol: string;
}

export interface Strike {
  'strike-price': string;
  call?: string;
  'call-streamer-symbol'?: string;
  put?: string;
  'put-streamer-symbol'?: string;
}

export interface Expiration {
  'expiration-type': string;
  'expiration-date': string;
  'days-to-expiration': number;
  'settlement-type': string;
  strikes: Strike[];
}

export interface OptionChain {
  'underlying-symbol': string;
  'root-symbol': string;
  'option-chain-type': string;
  'shares-per-contract': number;
  'tick-sizes'?: TickSize[];
  'deliverables'?: Deliverable[];
  expirations: Expiration[];
}

export type OptionChains = OptionChain[];

// Volume-augmented variants
export interface StrikeWithVolumes extends Strike {
  callVolume?: number;
  putVolume?: number;
  volume?: number; // generic fallback
}

export interface ExpirationWithVolumes extends Omit<Expiration, 'strikes'> {
  strikes: StrikeWithVolumes[];
}

export interface OptionChainWithVolumes extends Omit<OptionChain, 'expirations'> {
  expirations: ExpirationWithVolumes[];
}

export type OptionChainsWithVolumes = OptionChainWithVolumes[];
