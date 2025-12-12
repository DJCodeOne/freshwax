// src/lib/booking-calendar.ts
// Booking calendar logic for DJ slot selection
// Handles: rendering slots, selection rules, API calls

export interface TimeSlot {
  hour: number;
  displayHour: string;
  date: string;
  status: 'available' | 'booked' | 'selected' | 'past' | 'own-booking';
  booking?: {
    id: string;
    djId: string;
    djName: string;
    startTime: string;
    endTime: string;
    duration: number;
  };
}

export interface BookingCalendarOptions {
  mode: 'booking' | 'admin' | 'readonly';
  userId?: string;
  userDisplayName?: string;
  onSelectionChange?: (slots: TimeSlot[]) => void;
  maxSelectableHours?: number; // default 2
}

export class BookingCalendar {
  private container: HTMLElement;
  private gridEl: HTMLElement;
  private dateLabel: HTMLElement;
  private selectionInfo: HTMLElement;
  private options: BookingCalendarOptions;
  private currentDate: Date;
  private slots: TimeSlot[] = [];
  private selectedSlots: TimeSlot[] = [];
  private existingBookings: any[] = [];

  // Calendar runs from 9am to 8am next day (23 hours)
  private readonly START_HOUR = 9;
  private readonly END_HOUR = 8; // next day
  private readonly TOTAL_HOURS = 23;

  constructor(container: HTMLElement, options: BookingCalendarOptions) {
    this.container = container;
    this.options = {
      maxSelectableHours: 2,
      ...options
    };
    
    this.gridEl = container.querySelector('#calendarTimeGrid')!;
    this.dateLabel = container.querySelector('#calDateLabel')!;
    this.selectionInfo = container.querySelector('#selectionInfo')!;
    
    this.currentDate = new Date();
    this.currentDate.setHours(0, 0, 0, 0);
    
    this.setupNavigation();
    this.loadAndRender();
  }

  private setupNavigation() {
    const prevBtn = this.container.querySelector('#calPrevDay');
    const nextBtn = this.container.querySelector('#calNextDay');
    const todayBtn = this.container.querySelector('#calTodayBtn');

    prevBtn?.addEventListener('click', () => this.navigateDay(-1));
    nextBtn?.addEventListener('click', () => this.navigateDay(1));
    todayBtn?.addEventListener('click', () => this.goToToday());
  }

  private navigateDay(delta: number) {
    this.currentDate.setDate(this.currentDate.getDate() + delta);
    this.selectedSlots = [];
    this.loadAndRender();
  }

  private goToToday() {
    this.currentDate = new Date();
    this.currentDate.setHours(0, 0, 0, 0);
    this.selectedSlots = [];
    this.loadAndRender();
  }

  private async loadAndRender() {
    this.updateDateLabel();
    await this.loadBookings();
    this.buildSlots();
    this.render();
  }

  private updateDateLabel() {
    const options: Intl.DateTimeFormatOptions = { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric' 
    };
    this.dateLabel.textContent = this.currentDate.toLocaleDateString('en-GB', options);
  }

  private async loadBookings() {
    try {
      // Get bookings for current date and next day (since we span midnight)
      const startDate = new Date(this.currentDate);
      startDate.setHours(this.START_HOUR, 0, 0, 0);
      
      const endDate = new Date(this.currentDate);
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(this.END_HOUR, 0, 0, 0);

      const response = await fetch(
        `/api/livestream/slots?start=${startDate.toISOString()}&end=${endDate.toISOString()}&_t=${Date.now()}`
      );
      
      const data = await response.json();
      
      if (data.success) {
        this.existingBookings = data.slots || [];
      } else {
        this.existingBookings = [];
      }
    } catch (error) {
      console.error('Failed to load bookings:', error);
      this.existingBookings = [];
    }
  }

  private buildSlots() {
    this.slots = [];
    const now = new Date();

    // Build 23 hourly slots from 9am to 8am next day
    for (let i = 0; i < this.TOTAL_HOURS; i++) {
      const hour = (this.START_HOUR + i) % 24;
      const isNextDay = this.START_HOUR + i >= 24;
      
      const slotDate = new Date(this.currentDate);
      if (isNextDay) {
        slotDate.setDate(slotDate.getDate() + 1);
      }
      slotDate.setHours(hour, 0, 0, 0);

      const dateStr = slotDate.toISOString().split('T')[0];
      const displayHour = this.formatHour(hour);

      // Check if slot is in the past
      const isPast = slotDate < now;

      // Check if slot is booked
      const booking = this.findBookingForSlot(slotDate);

      let status: TimeSlot['status'] = 'available';
      
      if (isPast) {
        status = 'past';
      } else if (booking) {
        if (booking.djId === this.options.userId) {
          status = 'own-booking';
        } else {
          status = 'booked';
        }
      } else if (this.isSlotSelected(hour, dateStr)) {
        status = 'selected';
      }

      this.slots.push({
        hour,
        displayHour,
        date: dateStr,
        status,
        booking: booking ? {
          id: booking.id,
          djId: booking.djId,
          djName: booking.djName,
          startTime: booking.startTime,
          endTime: booking.endTime,
          duration: booking.duration || 60
        } : undefined
      });
    }
  }

  private findBookingForSlot(slotTime: Date): any {
    const slotStart = slotTime.getTime();
    const slotEnd = slotStart + 60 * 60 * 1000; // 1 hour later

    return this.existingBookings.find(booking => {
      const bookingStart = new Date(booking.startTime).getTime();
      const bookingEnd = new Date(booking.endTime).getTime();
      
      // Check if this slot overlaps with the booking
      return (slotStart >= bookingStart && slotStart < bookingEnd) ||
             (bookingStart >= slotStart && bookingStart < slotEnd);
    });
  }

  private isSlotSelected(hour: number, date: string): boolean {
    return this.selectedSlots.some(s => s.hour === hour && s.date === date);
  }

  private formatHour(hour: number): string {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${displayHour}:00 ${period}`;
  }

  private formatHourRange(startHour: number, endHour: number): string {
    return `${this.formatHour(startHour)} - ${this.formatHour(endHour)}`;
  }

  private render() {
    this.gridEl.innerHTML = '';

    this.slots.forEach((slot, index) => {
      // Time label
      const timeLabel = document.createElement('div');
      timeLabel.className = 'cal-time-label';
      timeLabel.textContent = slot.displayHour;
      this.gridEl.appendChild(timeLabel);

      // Slot cell
      const slotEl = document.createElement('div');
      slotEl.className = `cal-slot ${slot.status}`;
      slotEl.dataset.hour = slot.hour.toString();
      slotEl.dataset.date = slot.date;
      slotEl.dataset.index = index.toString();

      if (slot.status === 'booked' || slot.status === 'own-booking') {
        const nextHour = (slot.hour + 1) % 24;
        slotEl.innerHTML = `
          <div class="slot-content">
            <span class="slot-dj-name">${slot.booking?.djName || 'Reserved'}</span>
            <span class="slot-time-range">${this.formatHourRange(slot.hour, nextHour)}</span>
          </div>
        `;
      } else if (slot.status === 'selected') {
        slotEl.innerHTML = `
          <span class="slot-text">✓ Selected</span>
        `;
      } else if (slot.status === 'past') {
        slotEl.innerHTML = `
          <span class="slot-text" style="color: #999;">Past</span>
        `;
      } else {
        slotEl.innerHTML = `
          <span class="slot-text">Available</span>
        `;
      }

      // Click handler for booking mode
      if (this.options.mode === 'booking' && slot.status !== 'past' && slot.status !== 'booked') {
        slotEl.addEventListener('click', () => this.handleSlotClick(slot, index));
      }

      this.gridEl.appendChild(slotEl);
    });

    this.updateSelectionInfo();
  }

  private handleSlotClick(slot: TimeSlot, index: number) {
    if (slot.status === 'own-booking') {
      // Could show cancel option
      return;
    }

    if (slot.status === 'selected') {
      // Deselect
      this.selectedSlots = this.selectedSlots.filter(
        s => !(s.hour === slot.hour && s.date === slot.date)
      );
    } else {
      // Check if we can select this slot
      if (!this.canSelectSlot(slot, index)) {
        return;
      }
      
      // Add to selection
      this.selectedSlots.push(slot);
    }

    // Rebuild and re-render with new selection
    this.buildSlots();
    this.render();

    // Notify parent
    this.options.onSelectionChange?.(this.selectedSlots);
  }

  private canSelectSlot(slot: TimeSlot, index: number): boolean {
    const maxHours = this.options.maxSelectableHours || 2;
    
    // Check max selection
    if (this.selectedSlots.length >= maxHours) {
      // Check if selecting adjacent to make continuous 2hr block
      if (maxHours === 2 && this.selectedSlots.length === 1) {
        const existing = this.selectedSlots[0];
        const existingIndex = this.slots.findIndex(
          s => s.hour === existing.hour && s.date === existing.date
        );
        
        // Allow if adjacent
        if (Math.abs(index - existingIndex) === 1) {
          return true;
        }
      }
      
      this.showError('You can only book up to 2 hours per day');
      return false;
    }

    // If already have 1 selected, check the rules
    if (this.selectedSlots.length === 1) {
      const existing = this.selectedSlots[0];
      const existingIndex = this.slots.findIndex(
        s => s.hour === existing.hour && s.date === existing.date
      );
      
      // Check if adjacent (for 2hr continuous block)
      const isAdjacent = Math.abs(index - existingIndex) === 1;
      
      // If not adjacent, that's fine - they get 2x1hr non-consecutive
      // But we should warn if they're trying for non-continuous
      if (!isAdjacent && Math.abs(index - existingIndex) < 3) {
        // They selected slots too close but not adjacent - weird choice
        // Allow it but it counts as 2 separate 1hr slots
      }
    }

    return true;
  }

  private showError(message: string) {
    // Could show a toast or inline error
    console.warn(message);
    alert(message);
  }

  private updateSelectionInfo() {
    if (this.selectedSlots.length === 0) {
      this.selectionInfo.innerHTML = `
        <p class="selection-hint">Click a slot to select. You can book 1×2hr continuous OR 2×1hr slots per day.</p>
      `;
      return;
    }

    const tags = this.selectedSlots.map(slot => {
      const nextHour = (slot.hour + 1) % 24;
      return `
        <span class="selected-slot-tag">
          ${this.formatHourRange(slot.hour, nextHour)}
          <button type="button" class="remove-slot" data-hour="${slot.hour}" data-date="${slot.date}">×</button>
        </span>
      `;
    }).join('');

    const totalHours = this.selectedSlots.length;
    const isContinuous = this.isContinuousSelection();

    this.selectionInfo.innerHTML = `
      <p class="selection-hint">
        <strong>${totalHours} hour${totalHours > 1 ? 's' : ''} selected</strong>
        ${isContinuous && totalHours > 1 ? '(continuous block)' : totalHours > 1 ? '(2 separate slots)' : ''}
      </p>
      <div class="selection-summary">${tags}</div>
    `;

    // Add remove handlers
    this.selectionInfo.querySelectorAll('.remove-slot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const hour = parseInt(target.dataset.hour || '0');
        const date = target.dataset.date || '';
        this.selectedSlots = this.selectedSlots.filter(
          s => !(s.hour === hour && s.date === date)
        );
        this.buildSlots();
        this.render();
        this.options.onSelectionChange?.(this.selectedSlots);
      });
    });
  }

  private isContinuousSelection(): boolean {
    if (this.selectedSlots.length !== 2) return false;
    
    const indices = this.selectedSlots.map(slot => 
      this.slots.findIndex(s => s.hour === slot.hour && s.date === slot.date)
    ).sort((a, b) => a - b);
    
    return indices[1] - indices[0] === 1;
  }

  // Public methods
  getSelectedSlots(): TimeSlot[] {
    return [...this.selectedSlots];
  }

  clearSelection() {
    this.selectedSlots = [];
    this.buildSlots();
    this.render();
  }

  getCurrentDate(): Date {
    return new Date(this.currentDate);
  }

  refresh() {
    this.loadAndRender();
  }
}

// Export a factory function for easy initialization
export function initBookingCalendar(
  containerId: string, 
  options: BookingCalendarOptions
): BookingCalendar | null {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`Calendar container #${containerId} not found`);
    return null;
  }
  return new BookingCalendar(container, options);
}
