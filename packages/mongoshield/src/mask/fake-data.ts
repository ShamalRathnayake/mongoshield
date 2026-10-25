/**
 * Word lists for realistic fake values. Short on purpose: masked data needs to look
 * plausible in a UI, not to be statistically representative. Names are drawn from
 * many cultures so test data does not quietly assume one.
 *
 * The lists are written as space-separated strings to keep this file compact; none
 * of the words contains a space.
 */

/** Given names. */
export const FIRST_NAMES: readonly string[] = words(`
  Ada Aiko Amara Anders Ana Arjun Beatriz Bilal Chen Chiara Dara Diego Elena Emeka Farah
  Felix Grace Hana Hugo Ines Ivan Jamal Jonas Kai Kavya Lena Leila Luca Mai Malik Marta
  Mateo Mei Nadia Nikhil Noah Olu Priya Rafael Sanjay Sara Shamal Sofia Tariq Tomas Wei
  Yara Yusuf Zainab Zoe
`);

/** Family names. */
export const LAST_NAMES: readonly string[] = words(`
  Adeyemi Alvarez Andersen Bakker Banerjee Costa Dubois Fernando Fischer Garcia Haddad
  Hansen Ito Jansen Kaur Kim Kowalski Larsen Lee Lopez Mensah Moreau Murphy Nakamura
  Nguyen Novak Okafor Olsen Park Perera Petrov Rahman Rossi Santos Sato Schmidt Silva
  Singh Suzuki Tanaka Torres Wang Weber Wijesinghe Wilson Yamamoto Yilmaz Zhang Zhou Ziegler
`);

/** Street names, combined with a suffix and a house number. */
export const STREET_NAMES: readonly string[] = words(`
  Maple Oak Cedar Willow Elm Birch Lake Hill River Park Sunset Harbor Meadow Forest
  Garden Station Mill Church Bridge Spring
`);

/** Street suffixes. */
export const STREET_SUFFIXES: readonly string[] = words(
  "Street Avenue Road Lane Drive Way Court Place",
);

/** Fictional-sounding towns, so a fake address never points at a real one by design. */
export const CITIES: readonly string[] = words(`
  Springfield Riverton Lakeside Fairview Brookfield Oakridge Maplewood Clearwater Ashford
  Kingsbridge Northwick Eastvale Westfield Southport
`);

/**
 * Domains reserved for documentation by RFC 2606: mail to them can never reach
 * anyone, so a masked database used by a staging app cannot email real people.
 */
export const EMAIL_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];

/** Splits a whitespace-separated word list. */
function words(list: string): string[] {
  return list.split(/\s+/).filter((word) => word.length > 0);
}
