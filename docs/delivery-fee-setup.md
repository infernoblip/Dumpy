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

## Business UPI ID (optional, recommended)

Google Pay refuses one-tap payment links to a **personal** UPI ID ("bank limit reached"), so with a personal ID the taker copies your ID and types the amount. With a **business** UPI ID the taker taps their app and it opens with the amount and reference already filled in.

### Run the migration first
In Supabase, **SQL Editor > New query**: paste `supabase/migrations/20261026120000_business_upi.sql` and Run. It is safe to run before the code is merged: the live site keeps working.

### Get a free business UPI ID with PhonePe Business
Cost: the app and the account are free, and UPI payments of ₹2,000 or less carry no merchant fee (MDR), even under the rules that start on 15 October 2026. A ₹20 fee is far below that. Skip the optional paid extras the app offers (the SmartSpeaker or a card machine); you don't need them.

1. Install **PhonePe Business** (by PhonePe) from the Play Store or App Store.
2. Sign up with the mobile number that is linked to your bank account, and enter the OTP.
3. Enter a business name (for example "Dumpy"), a category close to what Dumpy does, and your address.
4. Choose the bank account to receive money in. It must use the same mobile number. Verify it when the app asks (it may send an SMS from your phone).
5. Finish KYC with your PAN (and Aadhaar if asked). If the app insists on a GSTIN and offers no "no GST" option, stop there and tell Claude in the Dumpy project.
6. Wait for approval. It can take 1 to 3 working days.
7. In the app, open your **QR code** (on the home screen or under "My QR").
8. Scan that QR code with **Google Lens** (or any QR scanner) on another phone, or take a screenshot and open it in Google Lens. It shows text starting with `upi://pay?pa=…`. Copy all of it.
9. On Dumpy, go to **Profile > Run Dumpy > Delivery fees**, tap **Your UPI ID** and paste. Dumpy fills in the UPI ID, the name and the merchant code, and ticks **This is a business UPI ID**. Tap **Save fee settings**.
10. Test it: book a helper for a cheap item with a second account, deliver it, and on the fee box tap Google Pay. It should open with ₹20 filled in. Back out if you don't want to pay yourself.
