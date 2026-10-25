# Delivery fee: setup for Arihaan

Dumpy earns a small flat fee each time a neighbour helper delivers an item.

## How it works

- Only the "A neighbour helper brings it" option carries a fee. "I'll bring it over" and "I'll collect it" stay free.
- The taker pays the fee. Any tip for the helper is unchanged: whatever the pair agree, paid straight to the helper.
- The fee is owed only after a helper delivers the item. If the delivery is called off, or the owner hands it over before a helper takes the job, nothing is owed, so there are never refunds.
- After delivery the taker sees **Pay ₹20 to Dumpy** on the item page. It opens their UPI app with the amount, your UPI ID and a reference such as `DLV-7F7740` in the note. They can also copy the UPI ID or scan the QR code. Then they tap **I've paid**.
- A taker who owes a fee and has not tapped I've paid can't book another helper until they pay. They can still use the two free options.
- The fee is copied onto each delivery when it is booked, so changing the amount later never changes a delivery that is already booked.
- Dumpy still holds no money. The fee goes straight from the taker's UPI app to your UPI ID.

## Steps

1. **Run the migration.** In the Supabase dashboard (project dumpy-mumbai), open **SQL Editor > New query**. Paste the whole of `supabase/migrations/20261025140000_delivery_fee.sql` and click **Run**. It should say "Success. No rows returned". The fee stays off until you finish step 3, so nothing changes for neighbours yet.
2. **Optional check.** Open another new query, paste `supabase/tests/delivery_fee_test.sql` and click **Run**. It ends with "All Dumpy delivery fee tests passed". It undoes everything it does, so it is safe on the live project.
3. **Turn the fee on.** On the website, go to **Profile > Run Dumpy**. Under **Delivery fees**:
   - **Fee per helper delivery:** the amount in rupees (for example 20). 0 turns it off.
   - **Your UPI ID:** the ID fees are paid to, such as `yourname@okaxis`.
   - **Name shown in UPI apps:** for example "Dumpy".
   - Tap **Save fee settings**.
4. **Check payments.** When a taker taps I've paid, the fee shows on Run Dumpy as **Says paid** with its reference. Find that reference in your UPI app's history, then tap **Confirm received**. If it never arrived, tap **Not received**: the taker sees Pay again and can't book another helper until they pay. You can also **Waive** a fee.

The totals at the top of the section show what you have received, what is waiting to be checked, what is not paid yet, and fees on deliveries that are booked but not delivered yet.
