// Static seed data: the 12 dashboard categories and clearly-marked DEMO document metadata.
// Demo records have no real file behind them (file_path is NULL, is_demo = 1).

export const CATEGORIES = [
  { slug: 'personal-documents', name: 'Personal Documents', icon: 'person', docs: ['Birth Certificate', 'Marriage Certificate', 'Address Proof', 'Family Details'] },
  { slug: 'educational-documents', name: 'Educational Documents', icon: 'school', docs: ['Bachelor Degree Certificate', 'Semester Marksheet', 'School Leaving Certificate', 'Diploma Certificate'] },
  { slug: 'identity-documents', name: 'Identity Documents', icon: 'badge', docs: ['Aadhaar Card', 'PAN Card', 'Driving Licence', 'Passport', 'Voter ID'] },
  { slug: 'work-career', name: 'Work & Career', icon: 'work', docs: ['Offer Letter', 'Experience Certificate', 'Salary Slip October', 'Employment Agreement', 'Appraisal Letter'] },
  { slug: 'financial-documents', name: 'Financial Documents', icon: 'wallet', docs: ['Bank Statement', 'Income Tax Return', 'Form 16', 'Loan Agreement', 'Investment Statement'] },
  { slug: 'medical-health', name: 'Medical & Health', icon: 'health', docs: ['Blood Test Report', 'Medical Prescription', 'Health Checkup Report', 'Vaccination Record', 'Medical Bill'] },
  { slug: 'insurance-documents', name: 'Insurance Documents', icon: 'shield', docs: ['Health Insurance Policy', 'Life Insurance Policy', 'Vehicle Insurance Policy', 'Insurance Premium Receipt', 'Insurance Claim Form'] },
  { slug: 'property-real-estate', name: 'Property & Real Estate', icon: 'home', docs: ['Rental Agreement', 'Property Tax Receipt', 'Sale Deed', 'Electricity Bill', 'Property Ownership Record'] },
  { slug: 'vehicle-documents', name: 'Vehicle Documents', icon: 'car', docs: ['Vehicle Registration Certificate', 'Pollution Certificate', 'Vehicle Service Invoice', 'Driving Record', 'Vehicle Insurance'] },
  { slug: 'bills-receipts', name: 'Bills & Receipts', icon: 'receipt', docs: ['Shopping Invoice', 'Laptop Purchase Receipt', 'Electricity Bill', 'Mobile Bill', 'Product Warranty'] },
  { slug: 'legal-documents', name: 'Legal Documents', icon: 'gavel', docs: ['Legal Agreement', 'Affidavit', 'Legal Notice', 'Court Order', 'Notarized Document'] },
  { slug: 'travel-documents', name: 'Travel Documents', icon: 'plane', docs: ['Flight Ticket', 'Hotel Booking', 'Visa Document', 'Travel Insurance', 'Train Ticket'] },
];

/** Names used by schema v1 that map onto new slugs (renamed categories). */
export const LEGACY_NAMES = { 'IDs': 'identity-documents', 'Work Related Documents': 'work-career' };

/** Flat list of demo documents with stable seed keys and deterministic dates. */
export function demoDocuments() {
  const out = [];
  CATEGORIES.forEach((cat, ci) => cat.docs.forEach((title, di) => {
    const day = String(1 + ((ci * 5 + di) % 28)).padStart(2, '0');
    const ts = `2026-0${1 + (ci % 9)}-${day}T09:00:00.000Z`;
    out.push({ seedKey: `${cat.slug}/${title}`, categorySlug: cat.slug, name: title, filename: `${title}.pdf`, ts });
  }));
  return out;
}
