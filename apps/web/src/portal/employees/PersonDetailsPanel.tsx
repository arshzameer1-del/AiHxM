import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { EmployeeView, HrReferenceCatalogItemView, MyPersonalDataView, PersonNationalIdType, PersonView, UpdatePersonRequest } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { PersonalDataCard } from "./PersonalDataCard";

/**
 * "Personal Details" tab of Employee maintenance: the person record behind an employee (middle and preferred name,
 * title, nationality, language, place of birth, passport, NTN, ID type), with its dated history. The same facts the
 * hiring wizard collects on its Personal Identity card, kept here for the life of the employee after they are hired.
 *
 * First name, last name, gender and marital status are NOT edited here: the employee record owns them (Overview > Edit)
 * and copies them onto the person, so a second place to edit them would let the two disagree.
 * A change can be dated (a new surname after marriage) and is kept as a new dated slice of the person's history.
 */
const NATIONAL_ID_TYPES: { value: PersonNationalIdType; label: string }[] = [
  { value: "cnic", label: "CNIC" },
  { value: "nicop", label: "NICOP" },
  { value: "passport", label: "Passport" },
  { value: "b_form", label: "B-Form" },
  { value: "other", label: "Other" },
];

const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

const blank = (v: string | null | undefined): string => v ?? "";
const nullable = (v: string): string | null => (v.trim() === "" ? null : v.trim());

function PickOrType({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options: HrReferenceCatalogItemView[] }) {
  // A saved value that is no longer in the list (renamed or switched off) stays selectable so editing never wipes it.
  const known = options.some((o) => o.label === value);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">—</option>
      {value && !known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.label}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PersonDetailsPanel({ employee, canManage }: { employee: EmployeeView; canManage: boolean }) {
  const personId = employee.personId;
  const [data, setData] = useState<MyPersonalDataView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [nationalities, setNationalities] = useState<HrReferenceCatalogItemView[]>([]);
  const [languages, setLanguages] = useState<HrReferenceCatalogItemView[]>([]);

  async function load() {
    if (!personId) return;
    try {
      const [person, history] = await Promise.all([api.getPerson(personId), api.getPersonHistory(personId)]);
      setData({ employeeId: employee.id, person, history });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "You are not allowed to see personal details." : "Could not load the personal details.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  useEffect(() => {
    if (!canManage) return;
    api.listHrCatalogItems("nationality").then(setNationalities).catch(() => setNationalities([]));
    api.listHrCatalogItems("language").then(setLanguages).catch(() => setLanguages([]));
  }, [canManage]);

  if (!personId) return <p className="text-sm text-label-tertiary">This employee has no person record yet, so there are no personal details to show.</p>;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-label-tertiary">Loading…</p>;

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" data-testid="person-details">
      {canManage && !editing && (
        <div className="flex justify-end mb-2">
          <button type="button" onClick={() => setEditing(true)} className="text-sm font-semibold text-accent hover:underline" data-testid="person-edit">
            Edit
          </button>
        </div>
      )}
      {editing && data.person ? (
        <PersonEditForm
          person={data.person}
          nationalities={nationalities}
          languages={languages}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
        />
      ) : (
        <PersonalDataCard employee={employee} data={data} hrView />
      )}
    </section>
  );
}

function PersonEditForm({
  person,
  nationalities,
  languages,
  onSaved,
  onCancel,
}: {
  person: PersonView;
  nationalities: HrReferenceCatalogItemView[];
  languages: HrReferenceCatalogItemView[];
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const canSeeIds = "passportNumber" in person;
  const [middleName, setMiddleName] = useState(blank(person.middleName));
  const [preferredName, setPreferredName] = useState(blank(person.preferredName));
  const [title, setTitle] = useState(blank(person.title));
  const [placeOfBirth, setPlaceOfBirth] = useState(blank(person.placeOfBirth));
  const [nationality, setNationality] = useState(blank(person.nationality));
  const [secondNationality, setSecondNationality] = useState(blank(person.secondNationality));
  const [language, setLanguage] = useState(blank(person.language));
  const [maritalStatusDate, setMaritalStatusDate] = useState(blank(person.maritalStatusDate));
  const [nationalIdType, setNationalIdType] = useState<PersonNationalIdType>(person.nationalIdType);
  const [passportNumber, setPassportNumber] = useState(blank(person.passportNumber));
  const [passportExpiry, setPassportExpiry] = useState(blank(person.passportExpiry));
  const [ntn, setNtn] = useState(blank(person.ntn));
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const patch: UpdatePersonRequest = {
        middleName: nullable(middleName),
        preferredName: nullable(preferredName),
        title: nullable(title),
        placeOfBirth: nullable(placeOfBirth),
        nationality: nullable(nationality),
        secondNationality: nullable(secondNationality),
        language: nullable(language),
        maritalStatusDate: nullable(maritalStatusDate),
        nationalIdType,
        passportExpiry: nullable(passportExpiry),
        ...(canSeeIds ? { passportNumber: nullable(passportNumber), ntn: nullable(ntn) } : {}),
        ...(effectiveDate ? { effectiveDate } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      await api.updatePerson(person.id, patch);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="person-edit-form">
      <p className="text-xs text-label-tertiary">
        {person.firstName} {person.lastName} · first name, last name, gender and marital status are changed on the Overview tab.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field id="pd-middle" label="Middle name">
          <input id="pd-middle" value={middleName} onChange={(e) => setMiddleName(e.target.value)} className={inputCls} />
        </Field>
        <Field id="pd-known" label="Known as">
          <input id="pd-known" value={preferredName} onChange={(e) => setPreferredName(e.target.value)} className={inputCls} />
        </Field>
        <Field id="pd-title" label="Title">
          <input id="pd-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Mr, Ms, Dr…" />
        </Field>
        <Field id="pd-birthplace" label="Place of birth">
          <input id="pd-birthplace" value={placeOfBirth} onChange={(e) => setPlaceOfBirth(e.target.value)} className={inputCls} />
        </Field>
        <Field id="pd-nationality" label="Nationality">
          <PickOrType id="pd-nationality" value={nationality} onChange={setNationality} options={nationalities} />
        </Field>
        <Field id="pd-nationality2" label="Second nationality">
          <PickOrType id="pd-nationality2" value={secondNationality} onChange={setSecondNationality} options={nationalities} />
        </Field>
        <Field id="pd-language" label="Communication language">
          <PickOrType id="pd-language" value={language} onChange={setLanguage} options={languages} />
        </Field>
        <Field id="pd-marital-since" label="Marital status since">
          <input id="pd-marital-since" type="date" value={maritalStatusDate} onChange={(e) => setMaritalStatusDate(e.target.value)} className={inputCls} />
        </Field>
        <Field id="pd-idtype" label="Primary ID type">
          <select id="pd-idtype" value={nationalIdType} onChange={(e) => setNationalIdType(e.target.value as PersonNationalIdType)} className={inputCls}>
            {NATIONAL_ID_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="pd-passport-expiry" label="Passport expiry">
          <input id="pd-passport-expiry" type="date" value={passportExpiry} onChange={(e) => setPassportExpiry(e.target.value)} className={inputCls} />
        </Field>
        {canSeeIds && (
          <>
            <Field id="pd-passport" label="Passport number">
              <input id="pd-passport" value={passportNumber} onChange={(e) => setPassportNumber(e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field id="pd-ntn" label="NTN">
              <input id="pd-ntn" value={ntn} onChange={(e) => setNtn(e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 border-t border-black/5 pt-4">
        <Field id="pd-effective" label="Takes effect on (optional)">
          <input id="pd-effective" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputCls} />
        </Field>
        <Field id="pd-reason" label="Reason (optional)">
          <input id="pd-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="Why this changed" />
        </Field>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" data-testid="person-save">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="bg-black/5 text-label-primary rounded-lg px-4 py-2 text-sm font-semibold">
          Cancel
        </button>
      </div>
    </form>
  );
}
