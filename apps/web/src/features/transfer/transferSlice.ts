import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

/**
 * §13.5's wizard, as a state machine rather than four booleans.
 *
 * Four steps that only move forwards through a legal sequence: you cannot
 * confirm an amount for a recipient who was never found, and you cannot go
 * back from a result. Written as a discriminated union so that is a type error
 * rather than a comment — a wizard held in loose flags eventually renders step
 * three with step one's data, and on this screen that means sending money to
 * somebody the user did not choose.
 *
 * **Lost on reload, deliberately** (§13.5). A half-finished money operation is
 * never restored: somebody returning to a tab an hour later should be starting
 * a transfer, not finishing one they have forgotten the shape of. That is also
 * why this is Redux rather than the outbox — the outbox holds requests that
 * were *committed to*, and nothing here has been.
 */

export interface Recipient {
  readonly phone: string
  readonly maskedName: string
}

export type TransferStep =
  /** Choosing who. Nothing has been decided. */
  | { readonly name: "recipient" }
  /** Who is known; choosing how much. */
  | { readonly name: "amount"; readonly recipient: Recipient }
  /** Both known; the last chance to stop. */
  | {
      readonly name: "confirm"
      readonly recipient: Recipient
      /** Minor units as a canonical string, exactly as it goes on the wire. */
      readonly amount: string
      /**
       * True once "Send" is pressed and until the server answers.
       *
       * S-6's first layer: the button is dead while this is set. The second
       * layer is the idempotency key, and the pairing is deliberate — a fast
       * double-tap can outrun a React render, so the key is what makes the
       * second request harmless and this is what makes it rare.
       */
      readonly submitting: boolean
    }
  /** Over, one way or the other. */
  | {
      readonly name: "result"
      readonly recipient: Recipient
      readonly amount: string
      readonly outcome: TransferOutcome
    }

export type TransferOutcome =
  | { readonly kind: "completed"; readonly transferId: string }
  /** Refused by the server, with a reason the user can act on. */
  | { readonly kind: "failed"; readonly code: string }
  /** Written to the outbox because it could not be sent (FR-8.3). */
  | { readonly kind: "queued" }

export interface TransferState {
  readonly step: TransferStep
}

const initialState: TransferState = { step: { name: "recipient" } }

export const transferSlice = createSlice({
  name: "transfer",
  initialState,
  reducers: {
    /** Step 1 → 2. Only a *found* recipient can advance (§13.5 rule 1). */
    recipientChosen(state, action: PayloadAction<Recipient>) {
      state.step = { name: "amount", recipient: action.payload }
    },

    /** Step 2 → 3. */
    amountChosen(state, action: PayloadAction<string>) {
      if (state.step.name !== "amount") return
      state.step = {
        name: "confirm",
        recipient: state.step.recipient,
        amount: action.payload,
        submitting: false,
      }
    },

    submitStarted(state) {
      if (state.step.name !== "confirm") return
      state.step = { ...state.step, submitting: true }
    },

    /**
     * The server answered, or the request was queued.
     *
     * Also clears `submitting`, which matters for the failure path: a refused
     * transfer returns to a live button, because the reason may be one the
     * user can fix and retry.
     */
    submitSettled(state, action: PayloadAction<TransferOutcome>) {
      if (state.step.name !== "confirm") return
      state.step = {
        name: "result",
        recipient: state.step.recipient,
        amount: state.step.amount,
        outcome: action.payload,
      }
    },

    /** A refusal the user can act on: back to the confirmation, button alive. */
    submitRefused(state) {
      if (state.step.name !== "confirm") return
      state.step = { ...state.step, submitting: false }
    },

    /**
     * One step back. Not available from `result`: the money has moved or it
     * has not, and either way the previous screen no longer describes
     * anything true.
     */
    steppedBack(state) {
      if (state.step.name === "amount") state.step = { name: "recipient" }
      else if (state.step.name === "confirm") {
        state.step = { name: "amount", recipient: state.step.recipient }
      }
    },

    /** Start over, from a cancel or from finishing one. */
    wizardReset() {
      return initialState
    },
  },
})

export const {
  amountChosen,
  recipientChosen,
  steppedBack,
  submitRefused,
  submitSettled,
  submitStarted,
  wizardReset,
} = transferSlice.actions
